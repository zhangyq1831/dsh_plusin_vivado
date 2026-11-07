@echo off
rem Windows launcher for the Vivado toolchain CLI.
rem Usage: bin\vivado.bat <command> [options]
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js 20 or newer and retry.
  exit /b 1
)
node "%~dp0vivado-cli.mjs" %*
exit /b %ERRORLEVEL%
