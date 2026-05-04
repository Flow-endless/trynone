' Launcher: no CMD window. If double-click does nothing, see start-all-launch.log or debug-start-all.bat
' Save this file as ANSI (GBK) if Chinese comments break; strings below are ASCII-only for compatibility.
Option Explicit
Dim sh, fso, dir, bat, logf, ts, cmdline, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = dir & "\start-all.bat"
logf = dir & "\start-all-launch.log"
If Not fso.FileExists(bat) Then
  MsgBox "Missing: " & bat, vbCritical, "start-all"
  WScript.Quit 1
End If
On Error Resume Next
Set ts = fso.CreateTextFile(logf, True)
If Not ts Is Nothing Then
  ts.WriteLine "---- " & Now & " ----"
  ts.WriteLine "dir=" & dir
  ts.Close
End If
On Error GoTo 0

' 0 = wait until user closes; user clicks OK to continue (avoids "nothing happens" confusion while Maven/npm run hidden)
MsgBox "Starting..." & vbCrLf & vbCrLf & _
  "The black window is hidden. First launch may take several MINUTES" & vbCrLf & _
  "(Maven may build the JAR, npm may install deps, then Electron opens)." & vbCrLf & vbCrLf & _
  "If nothing appears for a long time, open this file in Notepad:" & vbCrLf & logf, _
  vbInformation, "Deepseek"

cmdline = "cmd /c call """ & bat & """ _HIDDEN"
rc = sh.Run(cmdline, 0, True)
If rc <> 0 Then
  MsgBox "Startup failed (exit code " & rc & ")." & vbCrLf & vbCrLf & _
    "Opening the log file next.", vbExclamation, "Deepseek"
  sh.Run "notepad.exe """ & logf & """", 1, False
End If
