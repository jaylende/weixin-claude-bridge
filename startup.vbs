' Weixin-Claude bridge autostart - elevated (admin) via UAC prompt
' ShellExecute runas: one UAC prompt at logon, bridge runs as administrator.
CreateObject("Shell.Application").ShellExecute "C:\Users\Jaylen\weixin-claude-bridge\start-bridge.cmd", "", "", "runas", 0
