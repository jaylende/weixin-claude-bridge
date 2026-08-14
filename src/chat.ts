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

/**
 * 向 Claude 提问并流式获取完整回复。
 * 调用失败时回滚本次用户消息，抛出异常由调用方兜底。
 */
export async function askClaude(userId: string, text: string): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: text });

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const final = await stream.finalMessage();
    const reply = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!reply) {
      throw new Error("Claude 返回了空回复");
    }

    history.push({ role: "assistant", content: reply });
    persist(userId, history);
    return reply;
  } catch (err) {
    history.pop(); // 回滚，失败不污染历史
    throw err;
  }
}
