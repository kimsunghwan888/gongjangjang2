# 작업 스케줄러가 부르는 실행기: 화면 없이 server.js 를 돌리고 기록을 logs 에 남깁니다.
# 사용: run-task.ps1 make   /   run-task.ps1 post
param([Parameter(Mandatory)][ValidateSet('make','post')][string]$Task)
$Flag = "--$Task"
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = $Task
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'logs') | Out-Null
$o = Join-Path $env:TEMP "news_$name.out"; $e = Join-Path $env:TEMP "news_$name.err"
$p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js', $Flag -WorkingDirectory $dir `
  -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Hidden -PassThru -Wait
$log = Join-Path $dir "logs\$name.log"
Get-Content $o -Encoding UTF8 -ErrorAction SilentlyContinue | Add-Content $log -Encoding UTF8
Get-Content $e -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'DEP0190|trace-deprecation' } | Add-Content $log -Encoding UTF8
exit $p.ExitCode
