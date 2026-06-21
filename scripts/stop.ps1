param(
  [switch]$Infra
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$StateDir = if ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "YUVI\Runtime"
} else {
  Join-Path $RepoRoot ".yuvi-runtime"
}
$ServerMetadataFile = Join-Path $StateDir "server.pid"
$WebMetadataFile = Join-Path $StateDir "web.pid"
$RestartMarker = Join-Path $StateDir "restart-request.json"

. (Join-Path $PSScriptRoot "lib\yuvi-process.ps1")

Set-Location -LiteralPath $RepoRoot
Stop-YuviOwnedProcess -Name "Web" -MetadataPath $WebMetadataFile -ExpectedRole "web" -RepositoryRoot $RepoRoot -StateDirectory $StateDir | Out-Null
Stop-YuviOwnedProcess -Name "Server" -MetadataPath $ServerMetadataFile -ExpectedRole "server" -RepositoryRoot $RepoRoot -StateDirectory $StateDir | Out-Null
Remove-Item -LiteralPath $RestartMarker -Force -ErrorAction SilentlyContinue

if ($Infra) {
  docker compose -f (Join-Path $RepoRoot "infra\docker-compose.yml") down
  exit $LASTEXITCODE
}

Write-Host "YUVI development processes stopped. Docker infrastructure was left running."
