param(
  [int]$WebPort = 5173,
  [int]$ServerPort = 6121
)

$ErrorActionPreference = "Continue"
$RepoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$StateDir = if ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "YUVI\Runtime"
} else {
  Join-Path $RepoRoot ".yuvi-runtime"
}
$ServerMetadataFile = Join-Path $StateDir "server.pid"
$WebMetadataFile = Join-Path $StateDir "web.pid"
$Failed = $false

. (Join-Path $PSScriptRoot "lib\yuvi-process.ps1")

function Write-Status {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Healthy,
    [Parameter(Mandatory = $true)][string]$Detail
  )
  if ($Healthy) {
    Write-Host ("{0}: healthy - {1}" -f $Name, $Detail)
  } else {
    Write-Host ("{0}: unavailable - {1}" -f $Name, $Detail)
    $script:Failed = $true
  }
}

function Write-ProcessMetadataStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $ownership = Test-YuviProcessOwnership -MetadataPath $Path -ExpectedRole $Role -RepositoryRoot $RepoRoot -StateDirectory $StateDir
  if ($ownership.Owned) {
    Write-Status -Name $Name -Healthy $true -Detail "running ($($ownership.ProcessId))"
  } else {
    Write-Status -Name $Name -Healthy $false -Detail "$($ownership.Status): $($ownership.Message)"
  }
}

Set-Location -LiteralPath $RepoRoot

docker version *> $null
Write-Status -Name "Docker Engine" -Healthy ($LASTEXITCODE -eq 0) -Detail "docker version"

$postgresHealth = docker inspect --format "{{.State.Health.Status}}" companion-postgres 2>$null
if (-not $postgresHealth) { $postgresHealth = "not running" }
Write-Status -Name "PostgreSQL" -Healthy ($LASTEXITCODE -eq 0 -and $postgresHealth -eq "healthy") -Detail $postgresHealth

$redisHealth = docker inspect --format "{{.State.Health.Status}}" companion-redis 2>$null
if (-not $redisHealth) { $redisHealth = "not running" }
Write-Status -Name "Redis" -Healthy ($LASTEXITCODE -eq 0 -and $redisHealth -eq "healthy") -Detail $redisHealth

$natsHealth = docker inspect --format "{{.State.Health.Status}}" companion-nats 2>$null
if (-not $natsHealth) { $natsHealth = "not running" }
Write-Status -Name "NATS" -Healthy ($LASTEXITCODE -eq 0 -and $natsHealth -eq "healthy") -Detail $natsHealth

try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$ServerPort/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
  Write-Status -Name "Server /health" -Healthy $true -Detail "http://127.0.0.1:$ServerPort/health"
} catch {
  Write-Status -Name "Server /health" -Healthy $false -Detail $_.Exception.Message
}

try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort" -UseBasicParsing -TimeoutSec 3 | Out-Null
  Write-Status -Name "Web" -Healthy $true -Detail "http://127.0.0.1:$WebPort"
} catch {
  Write-Status -Name "Web" -Healthy $false -Detail $_.Exception.Message
}

Write-ProcessMetadataStatus -Name "Server metadata" -Role "server" -Path $ServerMetadataFile
Write-ProcessMetadataStatus -Name "Web metadata" -Role "web" -Path $WebMetadataFile

if ($Failed) {
  exit 1
}
exit 0
