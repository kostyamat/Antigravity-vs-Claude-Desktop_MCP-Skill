Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
WshShell.Run "cmd.exe /c ""node """ & scriptDir & "\board-ui.js"" --no-open >> """ & scriptDir & "\board_ui_stdout.log"" 2>> """ & scriptDir & "\board_ui_stderr.log""""", 0, False
