param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [int]$ServerPort = 6121
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $RepoRoot
$env:YUVI_RUNTIME_ENV_DIR = $RepoRoot
$env:SERVER_PORT = [string]$ServerPort
pnpm exec tsx --conditions development apps/server/src/index.ts
exit $LASTEXITCODE
