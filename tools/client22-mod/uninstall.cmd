@echo off
rem Removes the clan mod and restores the original client files (asks for administrator rights).
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0install.ps1\" -Uninstall'"
