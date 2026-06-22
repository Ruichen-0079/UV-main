param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$RestartMarker,
  [int]$ServerPort = 6121,
  [switch]$SkipMigrate
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $RepoRoot

function Import-YuviEnvFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $separator = $line.IndexOf("=")
    if ($separator -le 0) { return }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}

function Import-YuviRuntimeEnv {
  $shell = @{}
  Get-ChildItem Env: | ForEach-Object { $shell[$_.Name] = $_.Value }
  Import-YuviEnvFile -Path (Join-Path $RepoRoot ".env")
  foreach ($key in $shell.Keys) {
    Set-Item -Path "Env:$key" -Value $shell[$key]
  }
  Import-YuviEnvFile -Path (Join-Path $RepoRoot ".env.local")
  $env:YUVI_RUNTIME_ENV_DIR = $RepoRoot
  $env:SERVER_PORT = [string]$ServerPort
  $env:YUVI_DEV_SUPERVISOR = "1"
  $env:YUVI_RESTART_MARKER = $RestartMarker
}

while ($true) {
  Remove-Item -LiteralPath $RestartMarker -Force -ErrorAction SilentlyContinue
  Import-YuviRuntimeEnv
  if (-not $SkipMigrate -and $env:MEMORY_REPOSITORY -eq "postgres") {
    pnpm db:migrate
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  pnpm exec tsx --conditions development apps/server/src/index.ts
  $code = $LASTEXITCODE
  if ($code -ne 42 -and -not (Test-Path -LiteralPath $RestartMarker)) {
    exit $code
  }
  Write-Host "[supervisor] Deep restart requested; reloading env and restarting."
  Start-Sleep -Seconds 1
}
