Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. One board: the hidden launcher starts board-ui.js with --replace, so a board
' already on port 8787 leaves and the code on disk takes its place.
WshShell.Run "explorer.exe """ & scriptDir & "\board-ui-hidden.vbs""", 0, False
' The old board needs a moment to let go of the port; then wait for the new one
' (must check LISTENING: closed connections stay in TIME_WAIT and trick a plain findstr).
WScript.Sleep 2500
Dim i
For i = 1 To 40
    If WshShell.Run("cmd.exe /c ""netstat -ano | findstr :8787 | findstr LISTENING >nul""", 0, True) = 0 Then
        Exit For
    End If
    WScript.Sleep 250
Next

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
