// 一次性工具：把电脑上的文件经微信发回给绑定用户。
// 用法: npx tsx scripts/send-files.ts <文件路径...>
import fs from "node:fs";
import path from "node:path";

import { loadBot, restoreContextTokens, STATE_DIR, CDN_BASE_URL } from "../src/state.js";
import { sendWeixinMediaFile } from "../src/vendor/messaging/send-media.js";

const files = process.argv.slice(2).filter((f) => f.trim());
if (!files.length) {
  console.error("用法: npx tsx scripts/send-files.ts <文件路径...>");
  process.exit(1);
}

const bot = loadBot();
if (!bot?.token) {
  console.error("未登录：先 npm start login");
  process.exit(1);
}

restoreContextTokens();
// 绑定用户 = context-tokens.json 中的用户 ID
const tokensPath = path.join(STATE_DIR, "context-tokens.json");
const userIds = ((): string[] => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(tokensPath, "utf-8")));
  } catch {
    return [];
  }
})();
const to = userIds[0] ?? bot.userId ?? "";
if (!to) {
  console.error("找不到目标用户（context-tokens.json 为空）");
  process.exit(1);
}

for (const file of files) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`跳过（不存在）: ${abs}`);
    continue;
  }
  try {
    const result = await sendWeixinMediaFile({
      filePath: abs,
      to,
      text: "",
      opts: { baseUrl: bot.baseUrl || "https://ilinkai.weixin.qq.com", token: bot.token! },
      cdnBaseUrl: CDN_BASE_URL,
    });
    console.log(`已发送: ${path.basename(abs)} (messageId=${result.messageId})`);
  } catch (err) {
    console.error(`发送失败 ${abs}: ${String(err)}`);
  }
}
