' Weixin-Claude bridge autostart (windowless, elevated, portable).
' Launched from HKCU Run key at logon. Delegates to the windowless watchdog
' in the same directory as this script.
Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim scriptDir : scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & scriptDir & "\start-bridge-hidden.vbs""", 0, False
