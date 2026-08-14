import "./env.js";

import path from "node:path";
import QRCode from "qrcode";

import { loadBot, saveBot, STATE_DIR, DEFAULT_BASE_URL } from "./state.js";
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
  DEFAULT_ILINK_BOT_TYPE,
} from "./vendor/login-qr.js";
import { startBridge } from "./bridge.js";

// ---------------------------------------------------------------------------
// login：扫码登录，获取 bot token
// ---------------------------------------------------------------------------

async function login(): Promise<void> {
  console.log("正在获取登录二维码...");
  const start = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!start.qrcodeUrl) {
    console.error("❌ 获取二维码失败:", start.message);
    process.exit(1);
  }

  console.log("用手机微信扫描以下二维码：\n");
  await displayQRCode(start.qrcodeUrl);
  // 同时保存 PNG 图片，方便在图形界面打开后用手机扫
  try {
    const qrPath = path.join(STATE_DIR, "login-qr.png");
    await QRCode.toFile(qrPath, start.qrcodeUrl, { width: 480, margin: 2 });
    console.log(`\n📱 二维码图片已保存到: ${qrPath}`);
    console.log("   打开这个图片文件，用手机微信扫描屏幕上的二维码即可。\n");
  } catch (err) {
    console.log("(二维码图片生成失败，请使用上方链接)");
  }
  console.log("\n等待扫码确认（最长 8 分钟）...\n");

  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    timeoutMs: 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (result.connected && result.botToken) {
    saveBot({
      token: result.botToken,
      baseUrl: result.baseUrl || DEFAULT_BASE_URL,
      botId: result.accountId,
      userId: result.userId,
    });
    console.log(`\n✅ 登录成功！botId=${result.accountId}`);
    console.log("现在运行 npm start 启动桥，然后用你的微信给机器人发消息。");
  } else if (result.alreadyConnected) {
    console.log("\n✅ 已连接过，无需重复登录。直接运行 npm start。");
  } else {
    console.error("\n❌ 登录未完成:", result.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// status：显示当前配置
// ---------------------------------------------------------------------------

function status(): void {
  const bot = loadBot();
  if (!bot?.token) {
    console.log("未登录。运行 npm start login 完成扫码登录。");
    return;
  }
  console.log(`botId:    ${bot.botId ?? "(未知)"}`);
  console.log(`userId:   ${bot.userId ?? "(未知)"}`);
  console.log(`baseUrl:  ${bot.baseUrl ?? DEFAULT_BASE_URL}`);
  console.log(`token:    ${bot.token.slice(0, 8)}…(len=${bot.token.length})`);
  console.log(`模型:      ${process.env.ANTHROPIC_MODEL || "claude-opus-5"}`);
  console.log(`API key:   ${process.env.ANTHROPIC_API_KEY ? "已设置 ✓" : "未设置 ✗（请在 .env 中配置 ANTHROPIC_API_KEY）"}`);
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  console.log(`代理:      ${proxy ?? "未设置（假定透明代理直连）"}`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const cmd = process.argv[2] ?? "start";

if (cmd === "login") {
  await login();
} else if (cmd === "status") {
  status();
} else if (cmd === "start" || cmd === "run") {
  await startBridge();
} else {
  console.log("用法：npm start [login|status]");
  console.log("  login   扫码登录微信机器人");
  console.log("  status  查看当前配置状态");
  console.log("  start   启动桥（默认命令）");
}
