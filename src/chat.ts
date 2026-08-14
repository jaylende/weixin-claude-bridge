import Anthropic from "@anthropic-ai/sdk";
import { ProxyAgent, fetch as undiciFetch } from "undici";

import { logger } from "./vendor/logger.js";
import { loadChatFile, saveChatFile } from "./state.js";
import type { ChatMessage } from "./state.js";

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

/** 调用 OpenAI 兼容格式的视觉模型，把图片转成文字描述。 */
async function describeImages(images: ImageInput[]): Promise<string> {
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
            ...images.map((img) => ({
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
    throw new Error(`视觉模型调用失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const desc = data.choices?.[0]?.message?.content?.trim();
  if (!desc) throw new Error("视觉模型返回空描述");
  return desc;
}

/**
 * 向 Claude 提问并流式获取完整回复。
 * 带图片时的降级链：原生视觉（模型支持）→ 外部视觉模型转描述（配了 VISION_API_KEY）
 * → 纯文本提示（都不行）。
 * 调用失败时回滚本次用户消息，抛出异常由调用方兜底。
 */
export async function askClaude(
  userId: string,
  text: string,
  images?: ImageInput[],
): Promise<string> {
  const history = getHistory(userId);
  // 历史里只存文本（图片不落历史，避免文件膨胀）
  const historyText = text.trim() || (images?.length ? "[图片消息]" : "");
  history.push({ role: "user", content: historyText });

  const run = async (withImages: boolean, overrideText?: string): Promise<string> => {
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

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        ...history.slice(0, -1),
        { role: "user" as const, content: userContent },
      ],
    });

    const final = await stream.finalMessage();
    const reply = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!reply) throw new Error("模型返回了空回复");
    return reply;
  };

  try {
    let reply: string;
    if (images?.length) {
      reply = await run(true).catch(async (err) => {
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
      reply = await run(false);
    }

    history.push({ role: "assistant", content: reply });
    persist(userId, history);
    return reply;
  } catch (err) {
    history.pop(); // 回滚，失败不污染历史
    throw err;
  }
}
