param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string]$WebHost = "127.0.0.1",
  [int]$WebPort = 5173
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $RepoRoot
$env:YUVI_RUNTIME_ENV_DIR = $RepoRoot
$env:YUVI_WEB_HOST = $WebHost
$env:YUVI_WEB_PORT = [string]$WebPort
pnpm --filter @companion/web dev
exit $LASTEXITCODE
