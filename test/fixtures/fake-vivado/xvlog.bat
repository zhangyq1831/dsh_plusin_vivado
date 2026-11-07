@echo off
node "%~dp0fake-tool.mjs" xvlog %*
exit /b %ERRORLEVEL%
