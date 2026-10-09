@echo off
setlocal
cd /d "%~dp0"
set PORT=3100

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js and run again.
  pause
  exit /b 1
)

if not exist node_modules call npm.cmd install

node -e "require('http').get('http://127.0.0.1:%PORT%/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >nul 2>&1
if errorlevel 1 start "Healthy Agent server" /min cmd /c "node server.js"

set /a n=0
:wait
node -e "require('http').get('http://127.0.0.1:%PORT%/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 goto open
set /a n+=1
if %n% GEQ 10 (
  echo Server did not start. Run "node server.js" in this folder to see the error.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:open
start "" "http://localhost:%PORT%"
