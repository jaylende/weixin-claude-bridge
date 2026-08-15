' Stop the bridge and its windowless watchdog.
' Double-click this file to stop the bridge completely.
' (Kills only the bridge's own node + start-bridge watchdog processes.)

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

Dim sh : Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -Command ""Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*start-bridge*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*weixin-claude-bridge*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }""", 0, True
