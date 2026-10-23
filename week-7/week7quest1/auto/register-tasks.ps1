# 작업 스케줄러에 매일 자동 실행 2개를 등록합니다. (다시 실행하면 덮어씁니다)
#   week7-reels-make : 매일 16:00 정부 보도자료로 영상 만들기
#   week7-reels-post : 매일 16:30 인스타·페이스북 릴스 게시
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'logs') | Out-Null

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

function Register-Reels($name, $time, $script, $logName) {
  $arg = "/c `"`"$node`" $script >> logs\$logName.log 2>&1`""
  $action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -Daily -At $time
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  "$name 등록됨 ($time, $script)"
}

Register-Reels 'week7-reels-make' '16:00' 'make.js' 'make'
Register-Reels 'week7-reels-post' '16:30' 'post.js' 'post'
