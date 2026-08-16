' Weixin-Claude bridge autostart (windowless, elevated).
' Launched from HKCU Run key at logon. Delegates to the windowless watchdog.
CreateObject("WScript.Shell").Run """C:\Users\Jaylen\weixin-claude-bridge\start-bridge-hidden.vbs""", 0, False
