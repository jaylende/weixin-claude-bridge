import fs from "node:fs";
import path from "node:path";

// 读取项目根 .env（KEY=VALUE，每行一个），已存在的环境变量优先。
// 无需额外依赖；ANTHROPIC_API_KEY / HTTPS_PROXY / ANTHROPIC_MODEL 均可在此配置。
try {
  const raw = fs.readFileSync(path.resolve(".env"), "utf-8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // 无 .env 文件时忽略
}

// vendor 模块（logger / login-qr）在加载时读取该变量确定状态目录，
// 因此必须在 import vendor 之前设置（index.ts 第一个 import 本模块）。
process.env.BRIDGE_STATE_DIR = process.env.BRIDGE_STATE_DIR || path.resolve("state");
