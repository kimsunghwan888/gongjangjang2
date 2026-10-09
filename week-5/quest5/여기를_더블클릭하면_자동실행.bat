@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js를 찾을 수 없습니다. Node.js를 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >nul 2>&1
if errorlevel 1 start "Research server" /min cmd /c "node server.js >> data\server.log 2>&1"

set /a attempts=0
:wait_for_server
node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 goto open_browser
set /a attempts+=1
if %attempts% geq 10 goto server_error
ping -n 2 127.0.0.1 >nul
goto wait_for_server

:open_browser
echo 리서치를 시작합니다. 검색이 끝나면 결과 화면을 엽니다.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 10; if (-not $health.data.providerConfigured) { Write-Output 'YouTube API 키가 설정되지 않았습니다.'; exit 2 }; try { $result = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/research/run' -TimeoutSec 300; Write-Output $result.data.message } catch { Write-Output '자동 리서치 실행에 실패했습니다.'; if ($_.ErrorDetails.Message) { Write-Output $_.ErrorDetails.Message }; exit 1 }"
if errorlevel 2 goto missing_api_key
if errorlevel 1 goto research_error
start "" "http://127.0.0.1:3000"
exit /b 0

:missing_api_key
echo.
echo 실제 검색을 하려면 .env 파일에 YouTube Data API v3 키를 입력해야 합니다.
echo .env.example을 참고해 .env를 만들고 YOUTUBE_API_KEY 값을 설정한 뒤 다시 실행해 주세요.
start "" "http://127.0.0.1:3000"
pause
exit /b 1

:research_error
echo.
echo 서버는 켜졌지만 리서치에 실패했습니다. 위 오류를 확인해 주세요.
start "" "http://127.0.0.1:3000"
pause
exit /b 1

:server_error
echo 서버를 시작하지 못했습니다. 오류 기록을 확인해 주세요:
echo "%~dp0data\server.log"
pause
exit /b 1
