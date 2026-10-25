@echo off
"%~dp0..\..\node.exe" "%~dp0abl.mjs" %*
exit /b %errorlevel%
