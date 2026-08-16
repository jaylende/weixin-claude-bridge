' Weixin-Claude bridge keep-alive - completely windowless and portable.
' Self-elevates once (silent on machines with UAC auto-elevate), then runs
' the restart loop inside wscript itself, so there is NO window to close.
' Double-click this file to start the bridge silently.

Function IsElevated()
    On Error Resume Next
    Dim shl : Set shl = CreateObject("WScript.Shell")
    shl.RegWrite "HKLM\SOFTWARE\WBridgeProbe\", 1, "REG_SZ"
    If Err.Number = 0 Then
        shl.RegDelete "HKLM\SOFTWARE\WBridgeProbe\"
        IsElevated = True
    Else
        Err.Clear
        IsElevated = False
    End If
End Function

If Not IsElevated() Then
    CreateObject("Shell.Application").ShellExecute "wscript.exe", _
        Chr(34) & WScript.ScriptFullName & Chr(34), "", "runas", 1
    WScript.Quit
End If

Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim scriptDir : scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Dim sh : Set sh = CreateObject("WScript.Shell")
Do
    ' Run the bridge; window style 0 = hidden. Waits until it exits.
    sh.Run "cmd /c cd /d """ & scriptDir & """ && call npm start >> ""state\bridge-run.log"" 2>&1", 0, True
    WScript.Sleep 10000
Loop
