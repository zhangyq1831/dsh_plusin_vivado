@echo off
node "%~dp0fake-tool.mjs" vivado %*
exit /b %ERRORLEVEL%
