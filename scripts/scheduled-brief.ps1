# Daily brief runner for Windows Task Scheduler.
#
# Why a wrapper:
#   - Task Scheduler runs with a restricted environment — Node/npm/yt-dlp/
#     ffmpeg installed via winget are usually NOT on the inherited PATH.
#     We refresh PATH from Machine + User scope before running.
#   - Working directory needs to be the project root so npm finds package.json.
#   - We log to a dated file in data/logs/ so failures leave a trail you
#     can inspect.
#   - We preserve the npm exit code so Task Scheduler's "Last Run Result"
#     correctly reflects success / failure.
#
# Manual run (for testing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled-brief.ps1

$ErrorActionPreference = 'Continue'

# Project root is the parent of /scripts. Resolved once so the script works
# regardless of where Task Scheduler invokes it from.
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

# Refresh PATH from machine + user scopes (Task Scheduler's session won't
# have whatever was set after install). Order matters: machine first, then
# user, then current — current is last so per-invocation tweaks still win.
$env:Path =
  [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
  [System.Environment]::GetEnvironmentVariable("Path","User")    + ";" +
  $env:Path

Set-Location $projectRoot

# Logging — one file per day, append on re-runs.
$logDir = Join-Path $projectRoot "data\logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$date    = Get-Date -Format 'yyyy-MM-dd'
$logFile = Join-Path $logDir "brief-$date.log"

$startedAt = Get-Date
"" | Out-File -Append -Encoding utf8 $logFile
"=== Started $startedAt ===" | Out-File -Append -Encoding utf8 $logFile

# Run the pipeline. 2>&1 merges stderr (where our logger writes) so it
# also lands in the log file. Tee-Object splits the stream to both the
# log file and stdout, so when run manually you see live output.
& npm run brief 2>&1 | Tee-Object -Append -FilePath $logFile

$exitCode = $LASTEXITCODE
$endedAt  = Get-Date
"=== Ended $endedAt (exit code: $exitCode) ===" |
  Out-File -Append -Encoding utf8 $logFile

exit $exitCode
