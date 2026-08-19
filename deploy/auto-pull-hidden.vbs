' 隱形啟動器：Interactive 身分的排程會閃 PowerShell 視窗，Jery 嫌煩。
' 用 WScript 以 0（隱藏）視窗模式呼叫，排程改叫這支。
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "auto-pull.ps1""", 0, False
