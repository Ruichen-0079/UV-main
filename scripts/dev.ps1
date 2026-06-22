param(
  [switch]$SkipInfra,
  [switch]$SkipMigrate,
  [switch]$Supervisor,
  [string]$WebHost = "127.0.0.1",
  [int]$WebPort = 5173,
  [int]$ServerPort = 6121
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
$ServerLog = Join-Path $StateDir "server.log"
$WebLog = Join-Path $StateDir "web.log"
$RestartMarker = Join-Path $StateDir "restart-request.json"

. (Join-Path $PSScriptRoot "lib\yuvi-process.ps1")

$script:StartedRoles = New-Object System.Collections.Generic.List[string]
$script:Completed = $false

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required tool: $Name"
  }
}

function Import-YuviEnvFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $keys = New-Object System.Collections.Generic.List[string]
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
    [void]$keys.Add($name)
  }
  if ($keys.Count -gt 0) {
    Write-Host ("[env] Loaded {0}: keys={1}" -f (Split-Path -Leaf $Path), (($keys | Sort-Object) -join ","))
  } else {
    Write-Host ("[env] Loaded {0}: no keys" -f (Split-Path -Leaf $Path))
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
  $legacy = Join-Path $RepoRoot "apps\server\.env.local"
  if (Test-Path -LiteralPath $legacy) {
    Write-Warning "$legacy exists but is not loaded. Move settings to the repository root .env.local."
  }
  $env:YUVI_RUNTIME_ENV_DIR = $RepoRoot
  if ([string]::IsNullOrWhiteSpace($env:SERVER_HOST)) {
    $env:SERVER_HOST = "127.0.0.1"
  }
  $env:SERVER_PORT = [string]$ServerPort
  $env:YUVI_WEB_HOST = $WebHost
  $env:YUVI_WEB_PORT = [string]$WebPort
  if ($Supervisor) {
    $env:YUVI_DEV_SUPERVISOR = "1"
    $env:YUVI_RESTART_MARKER = $RestartMarker
  }
}

function Wait-PostgresHealthy {
  for ($i = 0; $i -lt 30; $i++) {
    $health = docker inspect --format "{{.State.Health.Status}}" companion-postgres 2>$null
    if ($LASTEXITCODE -eq 0 -and $health -eq "healthy") {
      Write-Host "PostgreSQL is healthy."
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "PostgreSQL did not become healthy in time."
}

function Get-YuviShell {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwsh) { return $pwsh.Source }
  return (Get-Command powershell -ErrorAction Stop).Source
}

function Start-YuviProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string[]]$ScriptArguments,
    [Parameter(Mandatory = $true)][string]$MetadataFile,
    [Parameter(Mandatory = $true)][string]$LogFile
  )

  $ownership = Test-YuviProcessOwnership -MetadataPath $MetadataFile -ExpectedRole $Role -RepositoryRoot $RepoRoot -StateDirectory $StateDir
  if ($ownership.Owned) {
    Write-Host "$Name is already running with PID $($ownership.ProcessId)."
    return $false
  }
  Remove-YuviInvalidMetadata -Ownership $ownership -MetadataPath $MetadataFile

  $shell = Get-YuviShell
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $ScriptArguments
  $process = Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $RepoRoot -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -WindowStyle Hidden -PassThru
  $metadata = New-YuviProcessMetadata -Role $Role -ProcessId $process.Id -RepositoryRoot $RepoRoot -StateDirectory $StateDir -CommandMarker (Split-Path -Leaf $ScriptPath)
  Write-YuviProcessMetadata -Path $MetadataFile -Metadata $metadata
  [void]$script:StartedRoles.Add($Role)
  Write-Host "$Name started with PID $($process.Id). Log: $LogFile"
  return $true
}

function Wait-HttpOk {
  param([Parameter(Mandatory = $true)][string]$Url)
  for ($i = 0; $i -lt 30; $i++) {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "Timed out waiting for $Url"
}

function Write-LogTail {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path
  )

  foreach ($candidate in @($Path, "$Path.err")) {
    if (Test-Path -LiteralPath $candidate) {
      Write-Host ""
      Write-Host "Last lines from $Name log: $candidate"
      Get-Content -LiteralPath $candidate -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }
  }
}

function Stop-StartedProcesses {
  if ($script:StartedRoles.Contains("web")) {
    Stop-YuviOwnedProcess -Name "Web" -MetadataPath $WebMetadataFile -ExpectedRole "web" -RepositoryRoot $RepoRoot -StateDirectory $StateDir | Out-Null
  }
  if ($script:StartedRoles.Contains("server")) {
    Stop-YuviOwnedProcess -Name "Server" -MetadataPath $ServerMetadataFile -ExpectedRole "server" -RepositoryRoot $RepoRoot -StateDirectory $StateDir | Out-Null
  }
}

try {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Set-Location -LiteralPath $RepoRoot

  Write-Host "Checking development tools..."
  Test-Command node
  Test-Command pnpm
  if (-not $SkipInfra) {
    Test-Command docker
    docker version | Out-Null
    docker compose version | Out-Null
  }

  Import-YuviRuntimeEnv

  if (-not $SkipInfra) {
    docker compose -f (Join-Path $RepoRoot "infra\docker-compose.yml") up -d
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Wait-PostgresHealthy
  }

  if (-not $SkipMigrate -and $env:MEMORY_REPOSITORY -eq "postgres") {
    pnpm db:migrate
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  $serverScript = if ($Supervisor) {
    Join-Path $PSScriptRoot "dev-server-supervisor.ps1"
  } else {
    Join-Path $PSScriptRoot "dev-server-runner.ps1"
  }
  $serverArguments = @("-RepoRoot", [string]$RepoRoot, "-ServerPort", [string]$ServerPort)
  if ($Supervisor) {
    $serverArguments += @("-RestartMarker", $RestartMarker)
    if ($SkipMigrate) { $serverArguments += "-SkipMigrate" }
  }

  Start-YuviProcess -Name "Server" -Role "server" -ScriptPath $serverScript -ScriptArguments $serverArguments -MetadataFile $ServerMetadataFile -LogFile $ServerLog | Out-Null
  Wait-HttpOk -Url "http://127.0.0.1:$ServerPort/health"

  Start-YuviProcess -Name "Web" -Role "web" -ScriptPath (Join-Path $PSScriptRoot "dev-web-runner.ps1") -ScriptArguments @("-RepoRoot", [string]$RepoRoot, "-WebHost", $WebHost, "-WebPort", [string]$WebPort) -MetadataFile $WebMetadataFile -LogFile $WebLog | Out-Null
  Wait-HttpOk -Url "http://127.0.0.1:$WebPort"

  $script:Completed = $true
  Write-Host ""
  Write-Host "YUVI development services are running."
  Write-Host "Server: http://127.0.0.1:$ServerPort"
  Write-Host "Web: http://$WebHost`:$WebPort"
  Write-Host "State: $StateDir"
} catch {
  Write-Error $_
  Write-LogTail -Name "Server" -Path $ServerLog
  Write-LogTail -Name "Web" -Path $WebLog
  Stop-StartedProcesses
  exit 1
} finally {
  if (-not $script:Completed) {
    Stop-StartedProcesses
  }
}
