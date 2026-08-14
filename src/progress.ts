// 实时进度面板：内存事件总线 + SSE 推送 + 内置单页 HTML（零依赖）
// 浏览器打开 http://127.0.0.1:8787 观看桥的工作进度
import http from "node:http";

export type ProgressEvent = {
  id: number;
  at: number;
  type:
    | "bridge_started"
    | "message_received"
    | "model_calling"
    | "tool_executing"
    | "file_sending"
    | "file_sent"
    | "reply_sent"
    | "error";
  detail: string;
};

const events: ProgressEvent[] = [];
const MAX_EVENTS = 200;
const clients = new Set<http.ServerResponse>();
let nextId = 1;

/** 发布一条进度事件（同时推送给所有 SSE 客户端）。 */
export function emitProgress(
  type: ProgressEvent["type"],
  detail: string,
): void {
  const ev: ProgressEvent = { id: nextId++, at: Date.now(), type, detail };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

const TYPE_LABELS: Record<ProgressEvent["type"], string> = {
  bridge_started: "桥已启动",
  message_received: "收到消息",
  model_calling: "模型调用",
  tool_executing: "工具执行",
  file_sending: "发送文件",
  file_sent: "文件已发送",
  reply_sent: "回复完成",
  error: "出错",
};

const TYPE_COLORS: Record<ProgressEvent["type"], string> = {
  bridge_started: "#22c55e",
  message_received: "#3b82f6",
  model_calling: "#8b5cf6",
  tool_executing: "#f59e0b",
  file_sending: "#0ea5e9",
  file_sent: "#22c55e",
  reply_sent: "#22c55e",
  error: "#ef4444",
};

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信桥 · 实时进度</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2937; min-height: 100vh; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb; padding: 14px 20px; display: flex; align-items: center; gap: 10px; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 600; }
  #status { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #e5e7eb; color: #6b7280; }
  #status.busy { background: #dbeafe; color: #1d4ed8; animation: pulse 1.5s infinite; }
  @keyframes pulse { 50% { opacity: .55; } }
  #log { max-width: 860px; margin: 16px auto; padding: 0 12px 60px; }
  .ev { display: flex; gap: 12px; padding: 10px 12px; background: #fff; border-radius: 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .ev .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; flex: none; }
  .ev .time { flex: none; color: #9ca3af; font-size: 12px; font-variant-numeric: tabular-nums; width: 52px; padding-top: 1px; }
  .ev .body { flex: 1; min-width: 0; }
  .ev .tag { display: inline-block; font-size: 12px; font-weight: 600; margin-bottom: 2px; }
  .ev .detail { font-size: 13px; line-height: 1.5; word-break: break-all; white-space: pre-wrap; }
  #empty { text-align: center; color: #9ca3af; margin-top: 80px; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #111827; color: #e5e7eb; }
    header, .ev { background: #1f2937; border-color: #374151; }
    #status { background: #374151; color: #9ca3af; }
    #status.busy { background: #1e3a5f; color: #60a5fa; }
  }
</style>
</head>
<body>
<header><h1>🤖 微信桥实时进度</h1><span id="status">空闲</span></header>
<div id="log"><div id="empty">等待事件…（桥运行中，有新消息会实时显示）</div></div>
<script>
const LABELS = ${JSON.stringify(TYPE_LABELS)};
const COLORS = ${JSON.stringify(TYPE_COLORS)};
const log = document.getElementById("log");
const status = document.getElementById("status");
const empty = document.getElementById("empty");
let busyUntil = 0;

function fmt(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function addEvent(ev) {
  if (ev.type === "history") { ev.events.forEach(addEvent); return; }
  if (empty) { empty.remove(); }
  const row = document.createElement("div");
  row.className = "ev";
  const dot = document.createElement("div"); dot.className = "dot"; dot.style.background = COLORS[ev.type] || "#9ca3af";
  const time = document.createElement("div"); time.className = "time"; time.textContent = fmt(ev.at);
  const body = document.createElement("div"); body.className = "body";
  const tag = document.createElement("span"); tag.className = "tag"; tag.style.color = COLORS[ev.type] || "#9ca3af"; tag.textContent = LABELS[ev.type] || ev.type;
  const detail = document.createElement("div"); detail.className = "detail"; detail.textContent = ev.detail || "";
  body.append(tag, detail);
  row.append(dot, time, body);
  log.appendChild(row);
  // 忙/闲状态：收到消息后进入忙碌，回复完成或出错后恢复空闲
  if (ev.type === "message_received") { busyUntil = ev.at + 10 * 60 * 1000; }
  if (ev.type === "reply_sent" || ev.type === "error") { busyUntil = 0; }
  status.textContent = Date.now() < busyUntil ? "处理中…" : "空闲";
  status.className = Date.now() < busyUntil ? "busy" : "";
  while (log.children.length > 200) log.removeChild(log.firstChild);
}
const es = new EventSource("/events");
es.onmessage = (e) => addEvent(JSON.parse(e.data));
es.onerror = () => { status.textContent = "连接中断，重连中…"; };
</script>
</body>
</html>`;

/** 启动进度面板 HTTP 服务（仅监听 127.0.0.1）。 */
export function startProgressServer(port = 8787): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "history", events })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  server.listen(port, "127.0.0.1");
  return server;
}
