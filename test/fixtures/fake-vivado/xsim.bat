@echo off
node "%~dp0fake-tool.mjs" xsim %*
exit /b %ERRORLEVEL%
