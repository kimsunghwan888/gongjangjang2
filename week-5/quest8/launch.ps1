param([switch]$NoBrowser)
# 서버가 꺼져 있으면 백그라운드로 켜고, 대시보드를 브라우저로 연다.
$dir = $PSScriptRoot
$port = 8000
$py = @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", (Get-Command python -ErrorAction SilentlyContinue).Source) |
      Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $py) { exit 1 }

function Test-Up { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

if (-not (Test-Up)) {
    $env:PYTHONIOENCODING = "utf-8"
    Start-Process $py -ArgumentList "-m", "uvicorn", "api_server:app", "--host", "127.0.0.1", "--port", $port `
        -WorkingDirectory $dir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dir "server.log") -RedirectStandardError (Join-Path $dir "server.err")
    for ($i = 0; $i -lt 60 -and -not (Test-Up); $i++) { Start-Sleep -Seconds 1 }
}

if (-not $NoBrowser -and (Test-Up)) { Start-Process "http://localhost:$port" }
