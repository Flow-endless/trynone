' 无窗口启动桌面端：由 start-desktop.bat 调用，或可直接双击本文件
Option Explicit
Dim sh, fso, dir, bat
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = dir & "\start-desktop.bat"
If Not fso.FileExists(bat) Then
  MsgBox "找不到: " & bat, vbCritical, "desktop"
  WScript.Quit 1
End If
sh.Run "cmd /c """ & bat & """ _HIDDEN", 0, False
