# 작업 스케줄러에 매일 자동 실행 2개를 등록합니다. (다시 실행하면 덮어씁니다)
#   week7-news-make : 매일 18:30 뉴스 영상 만들기
#   week7-news-post : 매일 19:20 인스타·페이스북 게시
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'logs') | Out-Null
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 40)

function Register-News($name, $time, $flag) {
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\run-task.ps1`" $flag"
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -Daily -At $time
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  "$name registered ($time, $flag)"
}
Register-News 'week7-news-make' '18:30' 'make'
Register-News 'week7-news-post' '19:20' 'post'
