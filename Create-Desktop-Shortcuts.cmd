@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Create-Desktop-Shortcuts.ps1"
pause
