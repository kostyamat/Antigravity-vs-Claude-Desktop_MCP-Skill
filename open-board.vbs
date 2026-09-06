Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Check if board-ui.js is genuinely LISTENING on port 8787
' (Must check LISTENING, because closed connections stay in TIME_WAIT and trick basic findstr)
Dim isRunning
isRunning = (WshShell.Run("cmd.exe /c ""netstat -ano | findstr :8787 | findstr LISTENING >nul""", 0, True) = 0)

If Not isRunning Then
    ' Launch via Explorer shell to guarantee detached desktop session lifetime
    WshShell.Run "explorer.exe """ & scriptDir & "\board-ui-hidden.vbs""", 0, False
    ' Wait for port 8787 to bind (max 20 * 200ms = 4s)
    Dim i
    For i = 1 To 20
        WScript.Sleep 200
        If WshShell.Run("cmd.exe /c ""netstat -ano | findstr :8787 | findstr LISTENING >nul""", 0, True) = 0 Then
            Exit For
        End If
    Next
End If

' 2. Ensure Antigravity is running
Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
Set colAnti = objWMIService.ExecQuery("Select * from Win32_Process Where Name = 'Antigravity.exe'")
If colAnti.Count = 0 Then
    Dim antPath
    antPath = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\antigravity\Antigravity.exe"
    If fso.FileExists(antPath) Then
        WshShell.Run """" & antPath & """", 1, False
    End If
End If

' 3. Ensure Claude Desktop is running
Dim colClaude, p, claudeFound
Set colClaude = objWMIService.ExecQuery("Select * from Win32_Process Where Name = 'claude.exe'")
claudeFound = False
For Each p In colClaude
    If InStr(1, p.ExecutablePath, "WindowsApps", 1) > 0 Then
        claudeFound = True
        Exit For
    End If
Next
If Not claudeFound Then
    WshShell.Run "explorer.exe shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude", 1, False
End If

' 4. Open UI in default browser (preserves browser translation & context menu)
WshShell.Run "cmd.exe /c start http://127.0.0.1:8787/", 0, False
