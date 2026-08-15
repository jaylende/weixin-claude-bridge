@echo off
rem Weixin-Claude bridge keep-alive wrapper: restarts the bridge if it exits.
rem Registered in Task Scheduler as "WeixinClaudeBridge" (ONLOGON).
cd /d C:\Users\Jaylen\weixin-claude-bridge
:loop
echo [%date% %time%] starting bridge...
call "C:\Program Files\nodejs\npm.cmd" start >> "state\bridge-run.log" 2>&1
echo [%date% %time%] bridge exited (code %errorlevel%), restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
