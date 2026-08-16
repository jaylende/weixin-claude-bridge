import fs from "node:fs";
import path from "node:path";

/** 桥状态目录：默认项目根下 state/，可用 BRIDGE_STATE_DIR 覆盖。 */
export const STATE_DIR = path.resolve(process.env.BRIDGE_STATE_DIR || "state");

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 微信 CDN（媒体上传/下载） */
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** 收到的媒体文件保存目录 */
export const MEDIA_DIR = path.join(STATE_DIR, "media", "inbound");

// ---------------------------------------------------------------------------
// 通用 JSON 读写
// ---------------------------------------------------------------------------

export function readJson<T>(file: string): T | null {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    // 损坏文件按不存在处理
  }
  return null;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Bot 凭据（扫码登录后保存）
// ---------------------------------------------------------------------------

export type BotState = {
  token?: string;
  baseUrl?: string;
  /** ilink_bot_id，形如 hex@im.bot */
  botId?: string;
  /** 扫码绑定者的微信用户 ID */
  userId?: string;
  savedAt?: string;
};

const botPath = () => path.join(STATE_DIR, "bot.json");

export function loadBot(): BotState | null {
  return readJson<BotState>(botPath());
}

export function saveBot(data: BotState): void {
  writeJson(botPath(), { savedAt: new Date().toISOString(), ...data });
}

// ---------------------------------------------------------------------------
// getupdates 游标（防消息丢失）
// ---------------------------------------------------------------------------

const syncBufPath = () => path.join(STATE_DIR, "sync-buf.json");

export function loadSyncBuf(): string {
  return readJson<{ buf?: string }>(syncBufPath())?.buf ?? "";
}

export function saveSyncBuf(buf: string): void {
  writeJson(syncBufPath(), { buf });
}

// ---------------------------------------------------------------------------
// context_token（每用户会话上下文令牌，回发时必须原样带回）
// ---------------------------------------------------------------------------

const ctxTokensPath = () => path.join(STATE_DIR, "context-tokens.json");
const ctxTokenCache = new Map<string, string>();

export function restoreContextTokens(): void {
  const tokens = readJson<Record<string, string>>(ctxTokensPath()) ?? {};
  for (const [userId, token] of Object.entries(tokens)) {
    if (token) ctxTokenCache.set(userId, token);
  }
}

export function setContextToken(userId: string, token: string): void {
  ctxTokenCache.set(userId, token);
  const all = Object.fromEntries(ctxTokenCache.entries());
  writeJson(ctxTokensPath(), all);
}

export function getContextToken(userId: string): string | undefined {
  return ctxTokenCache.get(userId);
}

/** 所有建立过会话的用户 ID（用于主动发消息，如上线通知）。 */
export function getAllContextUserIds(): string[] {
  return [...ctxTokenCache.keys()];
}

// ---------------------------------------------------------------------------
// 便签本（用户经微信记的事）
// ---------------------------------------------------------------------------

export type Note = { id: number; text: string; at: number };

const notesPath = () => path.join(STATE_DIR, "notes.json");
let notesCache: Note[] | null = null;

export function loadNotes(): Note[] {
  if (notesCache) return notesCache;
  const data = readJson<Note[]>(notesPath());
  notesCache = Array.isArray(data) ? data : [];
  return notesCache;
}

export function addNote(text: string): Note {
  const notes = loadNotes();
  const note: Note = { id: (notes.at(-1)?.id ?? 0) + 1, text, at: Date.now() };
  notes.push(note);
  writeJson(notesPath(), notes);
  return note;
}

/** 删除成功返回 true。 */
export function deleteNote(id: number): boolean {
  const notes = loadNotes();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx < 0) return false;
  notes.splice(idx, 1);
  writeJson(notesPath(), notes);
  return true;
}

// ---------------------------------------------------------------------------
// 定时提醒（桥每分钟检查，到点主动发微信）
// ---------------------------------------------------------------------------

export type Reminder = {
  id: number;
  userId: string;
  /** 下次触发时间（毫秒时间戳） */
  at: number;
  message: string;
  /** true = 每天重复（触发后自动顺延 24 小时） */
  daily?: boolean;
  /** 每周重复的星期几：0=周日, 1=周一 … 6=周六（如 [1,3,5] 周一三五） */
  weeklyDays?: number[];
  done?: boolean;
};

const remindersPath = () => path.join(STATE_DIR, "reminders.json");
let remindersCache: Reminder[] | null = null;

export function loadReminders(): Reminder[] {
  if (remindersCache) return remindersCache;
  const data = readJson<Reminder[]>(remindersPath());
  remindersCache = Array.isArray(data) ? data : [];
  return remindersCache;
}

export function saveReminders(list: Reminder[]): void {
  remindersCache = list;
  writeJson(remindersPath(), list);
}

export function addReminder(r: Omit<Reminder, "id">): Reminder {
  const list = loadReminders();
  const item: Reminder = { ...r, id: (list.at(-1)?.id ?? 0) + 1 };
  list.push(item);
  saveReminders(list);
  return item;
}

/** 删除成功返回 true。 */
export function removeReminder(id: number): boolean {
  const list = loadReminders();
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  saveReminders(list);
  return true;
}

// ---------------------------------------------------------------------------
// 每用户聊天历史
// ---------------------------------------------------------------------------

function sanitizeFileName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

export function chatFilePath(userId: string): string {
  return path.join(STATE_DIR, "chat", `${sanitizeFileName(userId)}.json`);
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function loadChatFile(userId: string): ChatMessage[] | null {
  const data = readJson<ChatMessage[]>(chatFilePath(userId));
  if (!Array.isArray(data)) return null;
  return data.filter(
    (m): m is ChatMessage =>
      (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
}

export function saveChatFile(userId: string, messages: ChatMessage[]): void {
  writeJson(chatFilePath(userId), messages);
}
