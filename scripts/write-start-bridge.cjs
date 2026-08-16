// 生成 start-bridge.cmd（CRLF，%~dp0 动态定位项目目录，可移植）
const fs = require("fs");
const path = require("path");
const BS = String.fromCharCode(92); // 反斜杠，避免转义混乱
const lines = [
  "@echo off",
  "rem Weixin-Claude bridge keep-alive wrapper (portable, CRLF required).",
  "rem Self-minimize: relaunch minimized if not already.",
  'if "%MINIMIZED%"=="1" goto :main',
  "set MINIMIZED=1",
  'start /min cmd /c "%~f0" %*',
  "exit /b",
  ":main",
  'cd /d "%~dp0"',
  ":loop",
  "echo [%date% %time%] starting bridge...",
  'call npm start >> "state' + BS + 'bridge-run.log" 2>&1',
  "echo [%date% %time%] bridge exited (code %errorlevel%), restarting in 10s...",
  "timeout /t 10 /nobreak >nul",
  "goto loop",
  "",
].join("\r\n");
fs.writeFileSync(path.join(__dirname, "..", "start-bridge.cmd"), lines, "latin1");
console.log("start-bridge.cmd written (portable)");
