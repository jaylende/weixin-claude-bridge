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
  CDN_BASE_URL,
  MEDIA_DIR,
  loadBot,
  loadSyncBuf,
  saveSyncBuf,
  restoreContextTokens,
  setContextToken,
  getContextToken,
} from "./state.js";
import { askClaude } from "./chat.js";
import type { ImageInput } from "./chat.js";
import { downloadMediaFromItem } from "./vendor/media/media-download.js";
import { sendWeixinMediaFile } from "./vendor/messaging/send-media.js";
import { getMimeFromFilename } from "./vendor/media/mime.js";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** 微信 getupdates 会对同一条消息推送多次（图片尤其明显），按消息 ID 去重。 */
const MAX_RECENT_MESSAGE_KEYS = 500;
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

/** 按长度分块，优先在换行处断开。空文本返回空数组（不发消息）。 */
function splitText(text: string, maxLen = MAX_CHUNK_LEN): string[] {
  if (!text) return [];
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

/** 提取 item_list 中第一条文本；语音消息有转写文本时直接使用。 */
function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

/** 纯媒体消息无附带要求时的引导回复（合并窗口内没有文字消息到达）。 */
async function replyMediaReceived(
  from: string,
  mediaPath: string,
  mediaKind: string,
  opts: { baseUrl: string; token: string },
): Promise<void> {
  const label = (
    { image: "图片", video: "视频", file: "文件", voice: "语音" } as Record<string, string>
  )[mediaKind] ?? "文件";
  const text = `已收到${label}（${path.basename(mediaPath)}）。请告诉我你想对它做什么？`;
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: buildTextSendBody(from, text, getContextToken(from)),
    });
  } catch (err) {
    logger.warn(`引导回复发送失败 from=${from}: ${String(err)}`);
  }
}

/** 收到的媒体文件落盘：state/media/inbound/ */
async function saveMediaFile(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  if (maxBytes && buffer.length > maxBytes) {
    throw new Error(`media too large: ${buffer.length} > ${maxBytes}`);
  }
  const dir = subdir ? path.join(path.dirname(MEDIA_DIR), subdir) : MEDIA_DIR;
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = originalFilename
    ? path.extname(originalFilename)
    : contentType
      ? `.${(contentType.split("/")[1] || "bin").slice(0, 10)}`
      : ".bin";
  const name = originalFilename ? path.basename(originalFilename) : `media-${Date.now()}${ext}`;
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, buffer);
  return { path: filePath };
}

const MAX_IMAGE_BYTES_FOR_MODEL = 5 * 1024 * 1024; // 模型视觉单图上限

/** 最近收到的文件（每用户），供后续纯文本消息中的「这个文件」指代。 */
const recentInboundFiles = new Map<string, { path: string; at: number }>();
const RECENT_FILE_WINDOW_MS = 10 * 60_000; // 10 分钟内有效

/**
 * 待合并的媒体消息：微信把「文件+要求」拆成两条消息（文件在前），
 * 文件消息先挂起 3.5 秒，等文字要求到达后合并成一次处理，避免重复回复。
 */
const pendingMediaByUser = new Map<
  string,
  { mediaPath: string; mediaKind: "image" | "video" | "file" | "voice"; contextToken?: string; timer: NodeJS.Timeout }
>();
const MEDIA_MERGE_WINDOW_MS = 3500;

async function handleMessage(
  msg: WeixinMessage,
  opts: { baseUrl: string; token: string },
): Promise<void> {
  const from = msg.from_user_id ?? "";
  if (!from) return; // 无来源，跳过
  if (msg.message_type === MessageType.BOT) return; // 跳过 bot 自己的回显

  const text = extractText(msg.item_list).trim();

  // 媒体：下载 + 解密（微信 CDN 内容为 AES-128-ECB 加密）
  let mediaPath: string | undefined;
  let mediaKind: "image" | "video" | "file" | "voice" | undefined;
  const mediaItem = (msg.item_list ?? []).find(isMediaItem);
  if (mediaItem) {
    try {
      const saved = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: CDN_BASE_URL,
        saveMedia: saveMediaFile,
        log: (m) => logger.info(m),
        errLog: (m) => logger.error(m),
        label: `from=${from}`,
      });
      if (saved.decryptedPicPath) { mediaPath = saved.decryptedPicPath; mediaKind = "image"; }
      else if (saved.decryptedVideoPath) { mediaPath = saved.decryptedVideoPath; mediaKind = "video"; }
      else if (saved.decryptedFilePath) { mediaPath = saved.decryptedFilePath; mediaKind = "file"; }
      else if (saved.decryptedVoicePath) { mediaPath = saved.decryptedVoicePath; mediaKind = "voice"; }
    } catch (err) {
      logger.error(`媒体下载/解密失败 from=${from}: ${String(err)}`);
    }
  }

  if (!text && !mediaPath) return;

  const contextToken = msg.context_token || getContextToken(from);
  if (msg.context_token) setContextToken(from, msg.context_token);

  // 记录最近收到的文件，供后续文字消息指代
  if (mediaPath && mediaKind !== "image") {
    recentInboundFiles.set(from, { path: mediaPath, at: Date.now() });
  }

  // 纯媒体消息：挂起 3.5 秒等文字要求，合并成一次处理（微信把「文件+要求」拆成两条消息）
  if (mediaPath && !text) {
    const pending = { mediaPath, mediaKind: mediaKind!, contextToken };
    const timer = setTimeout(() => {
      pendingMediaByUser.delete(from);
      void replyMediaReceived(from, pending.mediaPath, pending.mediaKind, opts);
    }, MEDIA_MERGE_WINDOW_MS);
    pendingMediaByUser.set(from, { ...pending, timer });
    return;
  }

  // 文字消息：若 3.5 秒内有挂起的媒体消息，合并进来一起处理
  if (text && !mediaPath) {
    const pending = pendingMediaByUser.get(from);
    if (pending) {
      clearTimeout(pending.timer);
      pendingMediaByUser.delete(from);
      mediaPath = pending.mediaPath;
      mediaKind = pending.mediaKind;
    }
  }

  // 构造给模型的输入：图片走视觉；其他媒体只告知保存路径
  let prompt = text;
  let images: ImageInput[] | undefined;
  if (mediaKind === "image" && mediaPath) {
    const size = fs.statSync(mediaPath).size;
    if (size <= MAX_IMAGE_BYTES_FOR_MODEL) {
      images = [{
        data: fs.readFileSync(mediaPath).toString("base64"),
        mediaType: getMimeFromFilename(mediaPath) || "image/jpeg",
      }];
    } else {
      const note = `[用户发了一张 ${(size / 1024 / 1024).toFixed(1)}MB 的大图，已保存到 ${mediaPath}，当前模型无法查看]`;
      prompt = prompt ? `${prompt}\n${note}` : note;
    }
  } else if (mediaPath) {
    const kindLabel = (
      { image: "图片", video: "视频", file: "文件", voice: "语音" } as const
    )[mediaKind!];
    const note = `[用户刚发了一个${kindLabel}，保存在 ${mediaPath}。用户的要求若提到「这个文件」「它」，指的就是这个文件。如果无法读取或解析该文件，直接告知用户无法识别，不要反复尝试，也不要自己生成无关文件。]`;
    prompt = prompt ? `${prompt}\n${note}` : note;
  } else if (text && !mediaPath) {
    // 纯文本消息：若用户 10 分钟内发过文件，把文件路径附上供指代
    const recent = recentInboundFiles.get(from);
    if (recent && Date.now() - recent.at < RECENT_FILE_WINDOW_MS) {
      prompt = `${text}\n[用户最近发来的文件保存在 ${recent.path}。用户若提到「这个文件」「它」，指的就是这个文件。如果无法读取或解析，直接告知无法识别，不要反复尝试。]`;
    }
  }
  if (!prompt && images) prompt = ""; // askClaude 内会给纯图片消息补默认提问

  logger.info(`收到消息 from=${from}: ${(text || "<媒体>").slice(0, 80)} media=${mediaKind ?? "无"}`);

  await sendTypingTo(opts, from, contextToken, TypingStatus.TYPING);

  let reply: string;
  let files: string[] = [];
  try {
    const result = await askClaude(from, prompt, images);
    reply = result.reply;
    files = result.files;
  } catch (err) {
    logger.error(`模型调用失败 from=${from}: ${String(err)}`);
    reply = "抱歉，出错了，请稍后再试。";
  }

  for (const chunk of splitText(reply)) {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: buildTextSendBody(from, chunk, contextToken),
    });
  }

  // 生成的文件逐个发回微信
  for (const filePath of files) {
    try {
      await sendWeixinMediaFile({
        filePath,
        to: from,
        text: "", // 不带文字说明，微信文件消息本身会显示文件名
        opts: { baseUrl: opts.baseUrl, token: opts.token, contextToken },
        cdnBaseUrl: CDN_BASE_URL,
      });
      logger.info(`文件已发回微信 from=${from} file=${filePath}`);
    } catch (err) {
      logger.error(`文件发送失败 from=${from} file=${filePath}: ${String(err)}`);
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        body: buildTextSendBody(from, `文件 ${path.basename(filePath)} 发送失败：${String(err)}`, contextToken),
      }).catch(() => {});
    }
  }

  await sendTypingTo(opts, from, contextToken, TypingStatus.CANCEL);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 单实例锁 + 消息去重
// ---------------------------------------------------------------------------

const LOCK_FILE = path.join(process.env.BRIDGE_STATE_DIR || "state", "bridge.pid");

function acquireInstanceLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(fs.readFileSync(LOCK_FILE, "utf-8"));
      if (pid) {
        try {
          process.kill(pid, 0); // 进程还活着
          return false;
        } catch {
          // 锁文件是陈旧残留，继续获取
        }
      }
    }
  } catch {
    // 读取失败按无锁处理
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseInstanceLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // best-effort
  }
}

const recentMessageKeys = new Set<string>();

/** 消息去重 key；无 ID 的消息返回 null（不去重）。 */
function dedupeKey(msg: WeixinMessage): string | null {
  if (msg.message_id) return `mid:${msg.message_id}`;
  if (msg.seq != null && msg.create_time_ms) return `seq:${msg.seq}:${msg.create_time_ms}`;
  return null;
}

/** 若消息已处理过返回 true。 */
function isDuplicate(msg: WeixinMessage): boolean {
  const key = dedupeKey(msg);
  if (!key) return false;
  if (recentMessageKeys.has(key)) return true;
  recentMessageKeys.add(key);
  if (recentMessageKeys.size > MAX_RECENT_MESSAGE_KEYS) {
    const first = recentMessageKeys.values().next().value;
    if (first !== undefined) recentMessageKeys.delete(first);
  }
  return false;
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

  if (!acquireInstanceLock()) {
    console.error("❌ 桥已在运行（state/bridge.pid 被占用）。若确认没有其他实例，删除该文件后重试。");
    process.exit(1);
  }

  restoreContextTokens();

  await notifyStart(opts).catch(() => {
    /* 通知失败不阻断启动 */
  });

  const shutdown = (): void => {
    logger.info("收到退出信号，通知微信服务端停止...");
    clearInterval(refreshTimer);
    releaseInstanceLock();
    void notifyStop(opts).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(`bridge 已启动：botId=${bot.botId} baseUrl=${baseUrl}`);
  console.log("✅ 桥已启动，等待微信消息...（Ctrl+C 退出）");

  // iLink 连接有效期约 24 小时，定时刷新（参考 weixin-ClawBot-API 的重连机制）
  const REFRESH_INTERVAL_MS = 22 * 3_600_000;
  const refreshTimer = setInterval(() => {
    void notifyStart(opts)
      .then((r) => logger.info(`定时刷新连接 ret=${r.ret ?? "(无)"}`))
      .catch((e) => logger.warn(`定时刷新连接失败: ${String(e)}`));
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();

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
        if (isDuplicate(msg)) {
          logger.debug(`跳过重复消息 from=${msg.from_user_id} key=${dedupeKey(msg)}`);
          continue;
        }
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
