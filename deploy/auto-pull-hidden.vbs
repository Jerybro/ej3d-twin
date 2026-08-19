' Hidden launcher for the auto-pull scheduled task (Interactive logon flashes a
' console window otherwise). ASCII only: wscript reads this file as ANSI.
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "auto-pull.ps1""", 0, False
