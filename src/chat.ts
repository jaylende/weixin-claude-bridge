import Anthropic from "@anthropic-ai/sdk";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { logger } from "./vendor/logger.js";
import { loadChatFile, saveChatFile } from "./state.js";
import type { ChatMessage } from "./state.js";
import { emitProgress } from "./progress.js";
import { webSearch, webFetch } from "./search.js";

/** 模型：ANTHROPIC_MODEL 可覆盖，默认跟随官方推荐。 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

/** 历史保留条数（约 30 轮对话），超出从最旧截断。 */
const MAX_HISTORY_MESSAGES = 60;

const SYSTEM_PROMPT = [
  "你是一个通过微信与用户聊天的 AI 助手。",
  "要求：",
  "- 始终使用简体中文回复",
  "- 回答简洁直接、适合手机阅读，避免大段表格和复杂 Markdown 格式",
  "- 语气自然友好",
  "- 处理用户发来的文件时：优先用现成库（PDF 用 pymupdf/pdfplumber，Word 用 python-docx，Excel 用 openpyxl）。如果文件无法读取、解析失败或格式不支持，直接告知用户「无法识别这个文件」并说明原因，不要反复尝试不同的方法，也不要生成无关文件。",
  "- 按模板填写/修改 Word 文档时：必须复制模板文件后在其上修改（shutil.copy 模板 → python-docx 打开副本 → 改内容 → 另存），严禁从零新建 docx——模板的封面、表格、字体样式必须原样保留。旧版 .doc 模板先用 LibreOffice（soffice --headless --convert-to docx）转换。",
  "- 涉及时事新闻、最新数据、实时信息、你不确定的事实时，必须先用 web_search 搜索，必要时用 web_fetch 读取具体页面，再综合回答。禁止凭训练记忆编造近期信息。",
].join("\n");

/**
 * 构造 Anthropic 客户端。
 * 设了 HTTPS_PROXY 时用 undici ProxyAgent 包装 fetch（undici 不读系统代理）；
 * 未设置时假定本机透明代理（TUN）可直连，用 SDK 默认。
 */
function createClient(): Anthropic {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (proxy) {
    const agent = new ProxyAgent({ uri: proxy });
    return new Anthropic({
      fetch: (url, init) =>
        undiciFetch(
          url as string,
          { ...(init ?? {}), dispatcher: agent } as Parameters<typeof undiciFetch>[1],
        ),
    });
  }
  return new Anthropic();
}

const client = createClient();

/** 内存缓存：userId -> 对话历史 */
const historyCache = new Map<string, ChatMessage[]>();

// ---------------------------------------------------------------------------
// 文件生成工具（模型在电脑上干活：写文件 / 跑 Python 生成任意格式）
// ---------------------------------------------------------------------------

/** 工具产物的输出目录，生成的文件会发回微信。 */
const OUTPUTS_DIR = path.join(process.env.BRIDGE_STATE_DIR || "state", "outputs");

const TOOLS: Anthropic.Tool[] = [
  {
    name: "write_file",
    description:
      "在电脑上写一个文本类文件（txt/md/csv/json/html 等），内容必须一次给全。文件会发送给微信用户。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件名（不含目录，如 report.md）" },
        content: { type: "string", description: "文件的完整内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_python",
    description:
      "在电脑上执行 Python 代码生成或处理文件。可用库：python-docx、openpyxl、reportlab、PIL、pymupdf（import pymupdf 读写 PDF）、pdfplumber、pypdf、pycryptodome。产物保存到当前工作目录（os.getcwd()）。读输入文件用绝对路径。\n\n【重要】修改 Word 文档（如按模板填写报告）：必须先复制模板文件（shutil.copy），再用 python-docx 打开副本修改内容并另存——严禁从零创建 docx，否则模板格式（封面/表格/样式）全部丢失。旧版 .doc 模板先用 subprocess 调 LibreOffice 转换：soffice --headless --convert-to docx。",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "完整的 Python 代码，产物保存到当前工作目录" },
      },
      required: ["code"],
    },
  },
  {
    name: "read_pdf_pages",
    description:
      "读取 PDF 文件的全部文字内容（含扫描件/图片型 PDF——无文字层的页面会经视觉模型识别）。读 PDF 内容必须优先用这个工具，不要自己写代码解析。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF 文件的绝对路径" },
      },
      required: ["path"],
    },
  },
  {
    name: "web_search",
    description:
      "搜索网络获取最新信息（时事新闻、实时数据、不确定的事实等）。涉及最新/实时信息时必须先搜索再回答，不要凭训练记忆编造。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词（中文或英文）" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "抓取指定网页的正文文本。用于阅读搜索结果中的具体页面内容。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整网页 URL（https:// 开头）" },
      },
      required: ["url"],
    },
  },
];

/** 本轮调用中新生成的文件（执行工具时收集，最终发回微信）。 */
function collectGeneratedFiles(): Set<string> {
  return new Set<string>();
}

/** 沙箱校验：目标路径必须位于 OUTPUTS_DIR 内。 */
function resolveInsideOutputs(fileName: string): string {
  const target = path.resolve(OUTPUTS_DIR, path.basename(fileName));
  if (!target.startsWith(path.resolve(OUTPUTS_DIR))) {
    throw new Error("非法路径：" + fileName);
  }
  return target;
}

async function executeWriteFile(
  input: { path?: string; content?: string },
  generated: Set<string>,
): Promise<string> {
  const fileName = input.path?.trim();
  const content = input.content ?? "";
  if (!fileName) return "错误：缺少 path";
  const target = resolveInsideOutputs(fileName);
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  generated.add(target);
  return `已写入 ${path.basename(target)}（${content.length} 字符）`;
}

/** PDF 提取脚本（pymupdf 抽文字层 + 无文字页渲染 PNG）。 */
const EXTRACT_PDF_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/extract_pdf.py",
);

/**
 * 读取 PDF 全文：文字层直接提取；图片型页面渲染后经视觉模型（GLM）识别。
 * 覆盖扫描件/加密 PDF 场景，模型无需自己解析。
 */
async function executeReadPdfPages(
  input: { path?: string },
): Promise<string> {
  const pdfPath = input.path?.trim();
  if (!pdfPath) return "错误：缺少 path";
  if (!pdfPath.toLowerCase().endsWith(".pdf")) return "错误：只支持 .pdf 文件";
  if (!fs.existsSync(pdfPath)) return `错误：文件不存在 ${pdfPath}`;

  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const raw = execFileSync("python", [EXTRACT_PDF_SCRIPT, pdfPath], {
    cwd: OUTPUTS_DIR,
    timeout: 120_000,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  const data = JSON.parse(raw) as {
    pages: { index: number; has_text: boolean; text: string }[];
    images: { index: number; png: string }[];
  };

  let fullText = "";
  for (const page of data.pages) {
    if (page.has_text) {
      fullText += `\n--- 第${page.index + 1}页 ---\n${page.text}\n`;
    }
  }
  let imagePages = 0;
  if (data.images.length > 0) {
    if (!VISION_API_KEY) {
      fullText += `\n（共 ${data.images.length} 页无文字层，且未配置视觉模型，无法识别）\n`;
    } else {
      for (const img of data.images) {
        try {
          const pngPath = path.join(OUTPUTS_DIR, img.png);
          const buf = fs.readFileSync(pngPath);
          const desc = await describeImages([
            { data: buf.toString("base64"), mediaType: "image/png" },
          ]);
          fullText += `\n--- 第${img.index + 1}页（视觉识别）---\n${desc}\n`;
          imagePages += 1;
        } catch (err) {
          fullText += `\n--- 第${img.index + 1}页（视觉识别失败: ${String(err).slice(0, 100)}）---\n`;
        } finally {
          try {
            fs.unlinkSync(path.join(OUTPUTS_DIR, img.png));
          } catch {
            // best-effort
          }
        }
      }
    }
  }
  const maxLen = 20_000;
  const truncated = fullText.length > maxLen ? `${fullText.slice(0, maxLen)}\n…(内容过长已截断，如需要可换其他方式读取)` : fullText;
  return `共 ${data.pages.length} 页（${imagePages} 页经视觉识别）。内容如下：\n${truncated}`;
}

async function executeRunPython(
  input: { code?: string },
  generated: Set<string>,
): Promise<string> {
  const code = input.code ?? "";
  if (!code.trim()) return "错误：缺少 code";
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  // 记录执行前各文件的修改时间：新文件或内容被覆盖/改写的文件都算产物
  const before = new Map<string, number>();
  for (const f of fs.readdirSync(OUTPUTS_DIR)) {
    try {
      before.set(f, fs.statSync(path.join(OUTPUTS_DIR, f)).mtimeMs);
    } catch {
      // 忽略
    }
  }
  const scriptName = `_run_${Date.now()}.py`;
  const scriptPath = path.join(OUTPUTS_DIR, scriptName);
  fs.writeFileSync(scriptPath, code, "utf-8");
  try {
    const stdout = execFileSync("python", [scriptPath], {
      cwd: OUTPUTS_DIR,
      timeout: 60_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    for (const f of fs.readdirSync(OUTPUTS_DIR)) {
      if (f === scriptName) continue;
      const full = path.join(OUTPUTS_DIR, f);
      try {
        const mtime = fs.statSync(full).mtimeMs;
        const prev = before.get(f);
        if (prev === undefined || mtime > prev + 1) generated.add(full);
      } catch {
        // 忽略
      }
    }
    return stdout.trim() || "(执行成功，无控制台输出)";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `执行失败: ${e.message ?? String(err)}\nstderr: ${e.stderr ?? ""}`.slice(0, 2000);
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // best-effort
    }
  }
}

export function getHistory(userId: string): ChatMessage[] {
  const cached = historyCache.get(userId);
  if (cached) return cached;
  const loaded = loadChatFile(userId) ?? [];
  historyCache.set(userId, loaded);
  return loaded;
}

function persist(userId: string, messages: ChatMessage[]): void {
  if (messages.length > MAX_HISTORY_MESSAGES) {
    messages = messages.slice(-MAX_HISTORY_MESSAGES);
  }
  historyCache.set(userId, messages);
  saveChatFile(userId, messages);
}

export type ImageInput = { data: string; mediaType: string };

// ---------------------------------------------------------------------------
// 外部视觉模型（DeepSeek 等纯文本模型无视觉能力时的补充通道）
// 默认智谱 GLM-4V-Flash（永久免费）：图片 → 文字描述 → 主模型
// ---------------------------------------------------------------------------

const VISION_API_KEY = process.env.VISION_API_KEY;
const VISION_BASE_URL = process.env.VISION_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const VISION_MODEL = process.env.VISION_MODEL || "glm-4v-flash";

/**
 * 压缩图片以适配免费视觉模型的限制：
 * 最长边 1280px + JPEG 80%（微信原图动辄几 MB，免费档会拒绝）。
 * 压缩后没变小则返回原图。
 */
async function compressImage(img: ImageInput): Promise<ImageInput> {
  const { default: sharp } = await import("sharp");
  const buf = Buffer.from(img.data, "base64");
  const compressed = await sharp(buf)
    .rotate() // 处理 EXIF 方向
    .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  if (compressed.length < buf.length) {
    return { data: compressed.toString("base64"), mediaType: "image/jpeg" };
  }
  return img;
}

/** 调用 OpenAI 兼容格式的视觉模型，把图片转成文字描述。 */
async function describeImages(images: ImageInput[]): Promise<string> {
  const prepared = await Promise.all(images.map(compressImage));
  const res = await fetch(`${VISION_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            ...prepared.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            })),
            {
              type: "text",
              text: "请详细描述这张图片的内容，包括其中的文字、场景、人物、物品等所有可见信息。",
            },
          ],
        },
      ],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`视觉模型调用失败: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const desc = data.choices?.[0]?.message?.content?.trim();
  if (!desc) throw new Error("视觉模型返回空描述");
  return desc;
}

export type AskResult = { reply: string; files: string[] };

/**
 * 向 Claude 提问并流式获取完整回复，支持工具调用（写文件/跑 Python 生成文件）。
 * 带图片时的降级链：原生视觉（模型支持）→ 外部视觉模型转描述（配了 VISION_API_KEY）
 * → 纯文本提示（都不行）。
 * 调用失败时回滚本次用户消息，抛出异常由调用方兜底。
 */
export async function askClaude(
  userId: string,
  text: string,
  images?: ImageInput[],
): Promise<AskResult> {
  const history = getHistory(userId);
  // 历史里只存文本（图片/工具产物不落历史，避免文件膨胀）
  const historyText = text.trim() || (images?.length ? "[图片消息]" : "");
  history.push({ role: "user", content: historyText });

  const MAX_TOOL_ROUNDS = 12;

  const run = async (withImages: boolean, overrideText?: string): Promise<AskResult> => {
    const generated = collectGeneratedFiles();
    const userContent = withImages && images?.length
      ? [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.data,
            },
          })),
          { type: "text" as const, text: text.trim() || "请描述这张图片。" },
        ]
      : (overrideText ?? historyText);

    const apiMessages: Anthropic.MessageParam[] = [
      ...history.slice(0, -1),
      { role: "user", content: userContent },
    ];

    let final = await streamOnce(apiMessages);
    let rounds = 0;

    // 工具循环：模型要调工具就执行并把结果回传，直到给出最终文本
    while (final.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
      rounds += 1;
      apiMessages.push({
        role: "assistant",
        content: final.content as Anthropic.MessageParam["content"],
      });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of final.content) {
        if (block.type !== "tool_use") continue;
        emitProgress("tool_executing", `执行工具 ${block.name}…`);
        let resultText: string;
        try {
          if (block.name === "write_file") {
            resultText = await executeWriteFile(block.input as { path?: string; content?: string }, generated);
          } else if (block.name === "run_python") {
            resultText = await executeRunPython(block.input as { code?: string }, generated);
          } else if (block.name === "read_pdf_pages") {
            resultText = await executeReadPdfPages(block.input as { path?: string });
          } else if (block.name === "web_search") {
            const q = (block.input as { query?: string }).query?.trim() ?? "";
            if (!q) {
              resultText = "错误：缺少 query";
            } else {
              const results = await webSearch(q);
              resultText = results.length
                ? results
                    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
                    .join("\n\n")
                : "(无搜索结果，换个关键词试试)";
            }
          } else if (block.name === "web_fetch") {
            const u = (block.input as { url?: string }).url?.trim() ?? "";
            if (!u) {
              resultText = "错误：缺少 url";
            } else {
              resultText = await webFetch(u);
            }
          } else {
            resultText = `未知工具: ${block.name}`;
          }
          logger.info(`工具 ${block.name} 执行完成: ${resultText.slice(0, 100)}`);
        } catch (err) {
          resultText = `工具执行出错: ${String(err)}`;
          logger.error(`工具 ${block.name} 执行失败: ${String(err)}`);
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultText,
        });
      }
      apiMessages.push({ role: "user", content: results });
      final = await streamOnce(apiMessages);
    }

    const reply = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!reply && final.stop_reason === "tool_use") {
      // 工具轮数耗尽仍在要工具：任务未完成，给出可续做提示
      if (generated.size > 0) {
        return { reply: "", files: [...generated] }; // 发已完成产物，不报错
      }
      return {
        reply: "任务比较复杂，我处理到一半达到轮数上限了。请回复「继续」，我会接着做。",
        files: [...generated],
      };
    }
    if (!reply && generated.size > 0) {
      // 工具全部执行完但模型没给总结文本（如被 max_tokens 截断）
      return { reply: "", files: [...generated] };
    }
    if (!reply) throw new Error("模型返回了空回复");
    return { reply, files: [...generated] };
  };

  const streamOnce = (messages: Anthropic.MessageParam[]) => {
    emitProgress("model_calling", `第 ${messages.length} 条消息上下文，模型 ${MODEL}`);
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    return stream.finalMessage();
  };

  try {
    let result: AskResult;
    if (images?.length) {
      result = await run(true).catch(async (err) => {
        // 模型不支持视觉（400）
        if (err instanceof Anthropic.BadRequestError) {
          if (VISION_API_KEY) {
            logger.info("主模型无视觉能力，改用外部视觉模型（" + VISION_MODEL + "）描述图片");
            const desc = await describeImages(images);
            const combined = [historyText, `[用户发来的图片内容描述]\n${desc}`]
              .filter(Boolean)
              .join("\n\n");
            return run(false, combined);
          }
          logger.warn(`主模型不支持图片且未配置 VISION_API_KEY，降级为纯文本: ${String(err).slice(0, 120)}`);
          return run(false);
        }
        throw err;
      });
    } else {
      result = await run(false);
    }

    // 历史只落最终文本（工具中间过程不持久化）
    history.push({ role: "assistant", content: result.reply || "已生成文件。" });
    persist(userId, history);
    return result;
  } catch (err) {
    history.pop(); // 回滚，失败不污染历史
    throw err;
  }
}
