Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
' No shell redirection: the board writes its own log (--log). A redirect here was held
' open by the running board and made every later launch fail before it started.
WshShell.Run "node """ & scriptDir & "\board-ui.js"" --no-open --replace --log", 0, False
