// OmniParser 屏幕解析服务封装：
// 截图 → OmniParser（本地 CUDA）→ 带坐标的可交互元素列表 → 模型选元素 → pyautogui 点击
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OMNIPARSER_ROOT = "C:\\Users\\Jaylen\\OmniParser";
const OMNI_PYTHON = "C:\\Users\\Jaylen\\omni-env\\Scripts\\python.exe";
const OMNI_SERVER_DIR = path.join(OMNIPARSER_ROOT, "omnitool", "omniparserserver");
const OMNI_URL = "http://127.0.0.1:8000";
const OMNI_PORT = 8000;

let omniProcess: ChildProcess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${OMNI_URL}/probe/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 按需启动 OmniParser 服务（模型加载需 20-60 秒，仅第一次）。 */
export async function ensureOmniParser(): Promise<void> {
  if (await probe()) return;
  if (!fs.existsSync(OMNI_PYTHON)) {
    throw new Error("OmniParser 环境未安装（缺少 omni-env）");
  }
  omniProcess = spawn(
    OMNI_PYTHON,
    [
      "-m",
      "omniparserserver",
      "--som_model_path",
      path.join(OMNIPARSER_ROOT, "weights", "icon_detect", "model.pt"),
      "--caption_model_name",
      "florence2",
      "--caption_model_path",
      path.join(OMNIPARSER_ROOT, "weights", "icon_caption_florence"),
      "--device",
      "cuda",
      "--port",
      String(OMNI_PORT),
    ],
    { cwd: OMNI_SERVER_DIR, stdio: "ignore", windowsHide: true },
  );
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    if (await probe()) return;
  }
  throw new Error("OmniParser 服务启动超时（3 分钟）");
}

/** 桥退出时停止服务进程。 */
export function stopOmniParser(): void {
  try {
    omniProcess?.kill();
  } catch {
    // best-effort
  }
  omniProcess = null;
}

let screenSize: { w: number; h: number } | null = null;

async function getScreenSize(): Promise<{ w: number; h: number }> {
  if (screenSize) return screenSize;
  const out = execFileSync(
    "python",
    ["-c", "import pyautogui; s=pyautogui.size(); print(s.width, s.height)"],
    { timeout: 15_000, encoding: "utf-8", windowsHide: true },
  );
  const [w, h] = out.trim().split(/\s+/).map(Number);
  screenSize = { w, h };
  return screenSize;
}

type ParsedElement = { type?: string; content?: string; bbox: number[] };

/**
 * 截屏并解析为可交互元素列表（含像素点击坐标）。
 * 返回给模型的格式化文本。
 */
export async function parseScreen(): Promise<string> {
  await ensureOmniParser();
  const { w, h } = await getScreenSize();

  // 截屏到临时文件
  const tmpDir = path.join(process.env.BRIDGE_STATE_DIR || "state", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const pngPath = path.join(tmpDir, `screen_${Date.now()}.png`);
  try {
    execFileSync(
      "python",
      ["-c", `import pyautogui; pyautogui.screenshot().save(r'${pngPath.replace(/\\/g, "\\\\")}')`],
      { timeout: 30_000, windowsHide: true },
    );
    const b64 = fs.readFileSync(pngPath).toString("base64");
    const res = await fetch(`${OMNI_URL}/parse/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64_image: b64 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`OmniParser HTTP ${res.status}`);
    const data = (await res.json()) as {
      parsed_content_list?: ParsedElement[];
      latency?: number;
    };
    const list = data.parsed_content_list ?? [];
    if (!list.length) return "屏幕解析完成但未发现可交互元素。";
    const lines = list.map((e, i) => {
      const [x1, y1, x2, y2] = e.bbox;
      const cx = Math.round(((x1 + x2) / 2) * w);
      const cy = Math.round(((y1 + y2) / 2) * h);
      return `[${i}] ${e.type ?? "?"} | ${(e.content ?? "").slice(0, 60)} | 点击坐标 (${cx}, ${cy})`;
    });
    return `屏幕 ${w}x${h}，可交互元素 ${list.length} 个（解析耗时 ${Math.round(data.latency ?? 0)}s）：\n${lines.join("\n")}\n（想点击某个元素：run_python 里 pyautogui.click(该元素坐标)）`;
  } finally {
    try {
      fs.unlinkSync(pngPath);
    } catch {
      // best-effort
    }
  }
}
