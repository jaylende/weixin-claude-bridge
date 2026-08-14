# weixin-claude-bridge

基于微信官方 iLink Bot 协议（`@tencent-weixin/openclaw-weixin` 同款协议，MIT），把 Claude 直接接入微信——不依赖 OpenClaw 框架，一个 Node 进程即可。

## 工作原理

```
微信用户 ←→ ilinkai.weixin.qq.com（微信官方服务器）←→ 本桥（Node）←→ Claude API
```

- **登录**：扫码获取 bot token（`ilink/bot/get_bot_qrcode` + `get_qrcode_status`）
- **收消息**：`ilink/bot/getupdates` 长轮询（35s，游标持久化防丢消息）
- **回复**：Claude 流式生成后经 `ilink/bot/sendmessage` 回发（带 `context_token` 维持会话上下文）

## 使用

```bash
npm install

# 1. 配置 Claude 凭据（复制 .env.example 为 .env 并填 ANTHROPIC_API_KEY）

# 2. 扫码登录（终端显示二维码，手机微信扫码确认）
npm start login

# 3. 启动桥
npm start

# 查看状态
npm run status
```

登录成功后，用扫码的那个微信直接给机器人发消息即可。每用户独立对话历史，重启不丢。

## 配置（.env 或系统环境变量）

| 变量 | 必填 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✓ | Claude API 密钥 |
| `ANTHROPIC_MODEL` | | 模型，默认 `claude-opus-5` |
| `HTTPS_PROXY` | | Claude API 代理地址（TUN 透明代理则无需设置） |

## 目录结构

```
src/
├── index.ts      # CLI：login / start / status
├── env.ts        # .env 读取 + 状态目录（须最先加载）
├── state.ts      # token/游标/context_token/聊天历史持久化
├── bridge.ts     # 长轮询主循环 + 消息分发 + 分块回复
├── chat.ts       # Claude 对话层（每用户历史、流式、代理）
└── vendor/       # 移植自 @tencent-weixin/openclaw-weixin（MIT）
    ├── api.ts        # 6 个 iLink Bot API
    ├── types.ts      # 协议类型
    ├── login-qr.ts   # 扫码登录状态机（含验证码/刷新/IDC 重定向）
    ├── random.ts     # ID 生成
    ├── logger.ts     # JSON 行日志 → state/logs/
    └── redact.ts     # 日志脱敏
```

## 当前范围与后续计划

已实现：文本对话（含上下文）、打字指示、长回复分块、token 失效检测、优雅退出。

未实现（可从原包按需移植 `src/cdn/*`）：图片/文件收发（CDN + AES-128-ECB 加解密）、多账号、群聊。

## 免责声明

本工具基于腾讯微信为 OpenClaw 开放的 iLink Bot 协议实现，仅供个人学习研究使用。协议未经官方正式文档化，存在变动风险；使用请遵守微信相关条款。
