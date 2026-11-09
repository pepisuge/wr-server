@echo off
rem Installs the clan mod. Usage: install.cmd <server IP> [web port]   (asks for administrator rights)
set "SERVER=%~1"
if "%SERVER%"=="" set /p "SERVER=Server IP address: "
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8080"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0install.ps1\" -Server %SERVER% -WebPort %PORT% -SetHosts'"
