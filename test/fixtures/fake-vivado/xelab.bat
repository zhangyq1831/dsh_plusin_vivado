@echo off
node "%~dp0fake-tool.mjs" xelab %*
exit /b %ERRORLEVEL%
