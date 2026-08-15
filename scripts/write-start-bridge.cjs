// 一次性脚本：以 CRLF 行尾重写 start-bridge.cmd（含自最小化头）
// 用法: node scripts/write-start-bridge.js
const fs = require("fs");

const lines = [
  "@echo off",
  "rem Weixin-Claude bridge keep-alive wrapper.",
  "rem Self-minimize: relaunch minimized if not already.",
  'if "%MINIMIZED%"=="1" goto :main',
  "set MINIMIZED=1",
  'start /min cmd /c "%~f0" %*',
  "exit /b",
  ":main",
  "cd /d C:\\Users\\Jaylen\\weixin-claude-bridge",
  ":loop",
  "echo [%date% %time%] starting bridge...",
  'call "C:\\Program Files\\nodejs\\npm.cmd" start >> "state\\bridge-run.log" 2>&1',
  "echo [%date% %time%] bridge exited (code %errorlevel%), restarting in 10s...",
  "timeout /t 10 /nobreak >nul",
  "goto loop",
  "",
].join("\r\n");

fs.writeFileSync(__dirname + "/../start-bridge.cmd", lines, "latin1");
console.log("start-bridge.cmd 已重写（CRLF）");
