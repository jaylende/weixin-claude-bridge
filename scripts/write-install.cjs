// 生成 install.cmd（CRLF、%~dp0 可移植）
const fs = require("fs");
const path = require("path");
const lines = [
  "@echo off",
  "chcp 65001 >nul",
  "rem One-click basic setup (optional OmniParser via: node scripts/omni-setup.cjs)",
  'cd /d "%~dp0"',
  "echo === Weixin Claude Bridge installer ===",
  "echo.",
  "where node >nul 2>nul || (echo [ERROR] Node.js not found. Install from https://nodejs.org first & pause & exit /b 1)",
  "where python >nul 2>nul || (echo [WARN] Python not found - file generation / PC control features need it)",
  "where soffice >nul 2>nul || (echo [WARN] LibreOffice not found - legacy .doc/.xls conversion needs it)",
  "echo.",
  "echo Installing npm packages...",
  "call npm install || (echo [ERROR] npm install failed & pause & exit /b 1)",
  "echo.",
  "echo Installing Python packages (CN mirror)...",
  "python -m pip install pyautogui python-docx openpyxl reportlab pillow pywinauto -i https://mirrors.aliyun.com/pypi/simple/ --timeout 60 --retries 2",
  "if errorlevel 1 (echo [WARN] Python packages failed - some features unavailable)",
  "echo.",
  "echo === Done ===",
  "echo 1. Copy .env.example to .env and fill ANTHROPIC_API_KEY (plus ANTHROPIC_BASE_URL / ANTHROPIC_MODEL if needed)",
  "echo 2. Run: npm start login   (scan QR with WeChat)",
  "echo 3. Run: npm start         (start the bridge)",
  "echo.",
  "echo [Optional] Screen recognition (OmniParser): node scripts/omni-setup.cjs",
  "pause",
  "",
].join("\r\n");
fs.writeFileSync(path.join(__dirname, "..", "install.cmd"), lines, "latin1");
console.log("install.cmd written");
