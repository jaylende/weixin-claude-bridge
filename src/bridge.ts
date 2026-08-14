import {
  getUpdates,
  sendMessage as sendMessageApi,
  getConfig,
  sendTyping,
  notifyStart,
  notifyStop,
} from "./vendor/api.js";
import { generateId } from "./vendor/random.js";
import { logger } from "./vendor/logger.js";
import type { WeixinMessage, MessageItem, SendTypingReq, SendMessageReq } from "./vendor/types.js";
import { MessageItemType, MessageState, MessageType, TypingStatus } from "./vendor/types.js";
import {
  DEFAULT_BASE_URL,
  loadBot,
  loadSyncBuf,
  saveSyncBuf,
  restoreContextTokens,
  setContextToken,
  getContextToken,
} from "./state.js";
import { askClaude } from "./chat.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
/** 会话超时/失效（原包 session-guard 的 STALE_TOKEN_ERRCODE） */
const STALE_TOKEN_ERRCODE = -14;
/** 单条微信消息最大文本长度，超出分块发送 */
const MAX_CHUNK_LEN = 4000;

// ---------------------------------------------------------------------------
// 发送工具
// ---------------------------------------------------------------------------

/** 构造单条文本消息的 sendMessage 请求体。 */
function buildTextSendBody(to: string, text: string, contextToken?: string): SendMessageReq {
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: generateId("wcb"),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      context_token: contextToken ?? undefined,
    },
  };
}

/** 按长度分块，优先在换行处断开。 */
function splitText(text: string, maxLen = MAX_CHUNK_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---------------------------------------------------------------------------
// 打字指示（typing ticket 按用户缓存）
// ---------------------------------------------------------------------------

let cachedTypingTicket: { userId: string; ticket: string } | null = null;

async function sendTypingTo(
  opts: { baseUrl: string; token: string },
  userId: string,
  contextToken: string | undefined,
  status: number,
): Promise<void> {
  try {
    if (!cachedTypingTicket || cachedTypingTicket.userId !== userId) {
      const resp = await getConfig({
        baseUrl: opts.baseUrl,
        token: opts.token,
        ilinkUserId: userId,
        contextToken,
      });
      if (resp.typing_ticket) {
        cachedTypingTicket = { userId, ticket: resp.typing_ticket };
      }
    }
    if (!cachedTypingTicket?.ticket) return;
    const body: SendTypingReq = {
      ilink_user_id: userId,
      typing_ticket: cachedTypingTicket.ticket,
      status,
    };
    await sendTyping({ baseUrl: opts.baseUrl, token: opts.token, body });
  } catch (err) {
    // 打字指示失败不影响主流程
    logger.debug(`sendTyping failed for ${userId}: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

/** 提取 item_list 中第一条文本；无文本（纯媒体/工具调用）返回空串。 */
function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

async function handleMessage(
  msg: WeixinMessage,
  opts: { baseUrl: string; token: string },
): Promise<void> {
  const from = msg.from_user_id ?? "";
  if (!from) return; // 无来源，跳过
  if (msg.message_type === MessageType.BOT) return; // 跳过 bot 自己的回显

  const text = extractText(msg.item_list).trim();
  if (!text) return; // 媒体/空消息，最小版跳过

  const contextToken = msg.context_token || getContextToken(from);
  if (msg.context_token) setContextToken(from, msg.context_token);

  logger.info(`收到消息 from=${from}: ${text.slice(0, 100)}`);

  await sendTypingTo(opts, from, contextToken, TypingStatus.TYPING);

  let reply: string;
  try {
    reply = await askClaude(from, text);
  } catch (err) {
    logger.error(`Claude 调用失败 from=${from}: ${String(err)}`);
    reply = "抱歉，出错了，请稍后再试。";
  }

  for (const chunk of splitText(reply)) {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: buildTextSendBody(from, chunk, contextToken),
    });
  }

  await sendTypingTo(opts, from, contextToken, TypingStatus.CANCEL);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startBridge(): Promise<void> {
  const bot = loadBot();
  if (!bot?.token) {
    console.error("尚未登录：请先运行 npm start login");
    process.exit(1);
  }
  const baseUrl = bot.baseUrl || DEFAULT_BASE_URL;
  const token = bot.token;
  const opts = { baseUrl, token };

  restoreContextTokens();

  await notifyStart(opts).catch(() => {
    /* 通知失败不阻断启动 */
  });

  const shutdown = (): void => {
    logger.info("收到退出信号，通知微信服务端停止...");
    void notifyStop(opts).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(`bridge 已启动：botId=${bot.botId} baseUrl=${baseUrl}`);
  console.log("✅ 桥已启动，等待微信消息...（Ctrl+C 退出）");

  let getUpdatesBuf = loadSyncBuf();
  let consecutiveFailures = 0;
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;

  for (;;) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        const isStale =
          resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;
        if (isStale) {
          logger.error(`token 已失效（errcode=${resp.errcode}），请重新运行 npm start login`);
          console.error("\n❌ 登录凭证已失效，请重新运行 npm start login");
          return;
        }
        consecutiveFailures += 1;
        logger.error(
          `getUpdates 失败 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncBuf(getUpdatesBuf);
      }

      for (const msg of resp.msgs ?? []) {
        try {
          await handleMessage(msg, opts);
        } catch (err) {
          logger.error(`处理消息失败 from=${msg.from_user_id}: ${String(err)}`);
        }
      }
    } catch (err) {
      consecutiveFailures += 1;
      logger.error(
        `getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}
