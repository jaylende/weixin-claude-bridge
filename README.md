# Weixin-Claude Bridge（微信 AI 助手桥）

把 AI 模型接入个人微信：扫码登录一次，你的微信就能和 AI 对话、收发文件、生成文档图表、甚至遥控电脑（点击、输入、看屏幕）。基于腾讯微信官方 iLink Bot 协议（`@tencent-weixin/openclaw-weixin` 同款，MIT），**不依赖 OpenClaw**，一个 Node 进程即可运行。

```
你的微信 ⇄ ilinkai.weixin.qq.com（微信官方服务器）⇄ 本桥（Node.js）⇄ AI 模型 API
```

## 功能

| 能力 | 说明 |
|---|---|
| 微信对话 | 多轮上下文、打字指示、长回复分块 |
| 文件收发 | 发文件/图片给 AI（自动解密保存），AI 生成的文件自动发回 |
| 文档处理 | 读 PDF（含扫描件 OCR）、按模板填 Word（保留格式）、Excel 处理 |
| 生成文件 | AI 写 Python 生成 docx/xlsx/pdf/图表并自动发回微信 |
| 图片理解 | 视觉模型识别图片内容（需配置 VISION_API_KEY） |
| 网络搜索 | 实时信息自动搜索（无需 key） |
| 电脑控制 | pyautogui 模拟键鼠 + OmniParser「看屏」（含精确坐标） |
| 人圈猫点 | AI 找不到目标时截图发你，你圈出位置发回，它精确点击 |
| 守护与自启 | 崩溃自动重启、开机静默自启（无窗口）、上线消息「小猫在」 |

## 快速开始（Windows，Node ≥ 22）

```powershell
# 1. 一键安装基础依赖
install.cmd

# 2. 配置 AI 凭据（复制 .env.example 为 .env 并填写）
#    ANTHROPIC_API_KEY=你的key          （必填）
#    ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   （可选：Anthropic 兼容端点）
#    ANTHROPIC_MODEL=deepseek-chat      （可选：默认 claude-opus-5）
#    VISION_API_KEY=xxx.yyy             （可选：智谱 GLM-4V-Flash 免费视觉模型）
#    HTTPS_PROXY=http://127.0.0.1:7890  （可选：访问 Claude 官方 API 需代理）

# 3. 扫码登录（终端出二维码，手机微信扫）
npm start login

# 4. 启动
npm start
```

登录成功后，用扫码的微信直接给机器人发消息即可。

## 可选：屏幕识别（让 AI「看见」电脑屏幕）

需要操作电脑（找按钮、点击）时强烈建议安装：

```powershell
node scripts/omni-setup.cjs
```

全自动完成：克隆 OmniParser（gitcode 镜像）→ 建 venv 装 CPU torch 与依赖（阿里云镜像）→ 下载权重（hf-mirror）→ 应用兼容性补丁。**国内网络直连可用，无需代理**。约 10-30 分钟（取决于带宽）。

装完后 AI 的 `see_screen` 工具能看到屏幕上的元素和精确坐标（约 8 秒/帧，CPU 版）。显卡加速（CUDA torch）在国内暂无可用的下载通道。

## 开机自启

```powershell
# 注册（当前用户，登录后静默启动）
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v WeixinClaudeBridge /t REG_SZ /d "wscript.exe \"%CD%\startup.vbs\"" /f
```

- 自启入口：`startup.vbs` → `start-bridge-hidden.vbs`（无窗口守护，崩溃 10 秒自动重启）
- 停止：双击 `stop-bridge.vbs`
- 上线通知：桥每次启动给微信发「小猫在」（改 `.env` 的 `BRIDGE_ONLINE_MESSAGE` 可自定义）

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start login` | 扫码登录 |
| `npm start` | 启动桥 |
| `npm run status` | 查看配置状态 |
| `npx tsx scripts/send-files.ts <文件...>` | 手动发文件到微信 |
| http://127.0.0.1:8787 | 实时进度面板 |

## 目录结构

```
src/
├── index.ts      # CLI：login / start / status
├── bridge.ts     # 长轮询 + 消息分发 + 产物发回 + 圈选协作
├── chat.ts       # AI 对话层：工具循环（写文件/跑 Python/搜索/看屏/读 PDF）
├── screen.ts     # OmniParser 服务封装（按需启动）
├── search.ts     # 网络搜索（Bing 国内版）+ 网页抓取
├── progress.ts   # 实时进度面板（SSE）
├── state.ts      # 状态持久化（token/游标/历史）
└── vendor/       # 移植自 @tencent-weixin/openclaw-weixin（MIT）
scripts/
├── omni-setup.cjs       # OmniParser 一键部署
├── extract_pdf.py       # PDF 文字层提取 + 扫描页渲染
└── send-files.ts        # 手动发文件工具
```

## 常见问题

- **微信显示「暂时无法连接」**：处理时间长的误报，桥实际在干活
- **「小猫在」没发**：查 `state/bridge-run.log` 与 `state/logs/`
- **发 .doc 打不开**：装了 LibreOffice 会自动转 .docx；没装则提示安装
- **AI 找不到按钮**：会自动截图发你，圈出位置发回即可
- **换回 Claude 官方**：`.env` 改 `ANTHROPIC_API_KEY=sk-ant-...` 并删除 `ANTHROPIC_BASE_URL` 行

## 隐私与安全

- 所有凭据仅存本地 `.env`（不入 git）；聊天记录存本地 `state/`
- AI 控制电脑时：危险操作（删除/支付等）会先征求你同意
- 微信账号经官方扫码授权，不涉及任何密码

## 免责声明

基于腾讯微信为 OpenClaw 开放的 iLink Bot 协议实现，仅供个人学习研究。协议未经官方正式文档化，存在变动风险；使用请遵守微信相关条款。
