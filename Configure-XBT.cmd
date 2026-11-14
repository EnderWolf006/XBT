@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Configure-XBT.ps1"
if errorlevel 1 pause
