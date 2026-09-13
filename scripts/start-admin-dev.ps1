$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $projectRoot '.local\admin-preview-dev'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$nodePath = (Get-Command node).Source
$statusUrl = 'http://127.0.0.1:8391/api/__admin-dev/status'
$existing = $null
try { $existing = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2 } catch { }
if ($existing -and $existing.environment -ne 'isolated-admin-development') { throw 'Port 8391 is occupied by another service.' }
if (-not $existing) {
  Start-Process -FilePath $nodePath -ArgumentList @('--watch','--watch-path=src','--import','tsx','src/smoke/admin-dev.ts') -WorkingDirectory (Join-Path $projectRoot 'server') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'api.stdout.log') -RedirectStandardError (Join-Path $stateDir 'api.stderr.log') | Out-Null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $ready = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2; if ($ready.environment -eq 'isolated-admin-development') { break } } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "Development API failed. See $stateDir\api.stderr.log" }
}
$frontend = $null
try { $frontend = Invoke-WebRequest -Uri 'http://127.0.0.1:5391/@vite/client' -TimeoutSec 2 -UseBasicParsing } catch { }
if (-not $frontend) {
  Start-Process -FilePath $nodePath -ArgumentList @('node_modules/vite/bin/vite.js','--config','admin-dev.vite.config.ts') -WorkingDirectory (Join-Path $projectRoot 'web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'web.stdout.log') -RedirectStandardError (Join-Path $stateDir 'web.stderr.log') | Out-Null
}
Write-Output 'Admin development: http://127.0.0.1:5391/admin'
Write-Output 'Synthetic data and test login: http://127.0.0.1:8491/'
