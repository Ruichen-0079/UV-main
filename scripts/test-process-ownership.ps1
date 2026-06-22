$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "lib\yuvi-process.ps1")

$stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ("yuvi-process-test-" + [guid]::NewGuid().ToString("n"))
$metadataPath = Join-Path $stateDir "server.pid"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$shell = (Get-Command powershell -ErrorAction Stop).Source
$process = $null
try {
  $process = Start-Process -FilePath $shell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Sleep -Seconds 60") -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300
  $info = Get-YuviProcessInfo -ProcessId $process.Id
  $fakeMetadata = [pscustomobject]@{
    schemaVersion = 1
    role = "server"
    pid = $process.Id
    repositoryRoot = (ConvertTo-YuviCanonicalPath -Path $RepoRoot)
    stateDirectory = (ConvertTo-YuviCanonicalPath -Path $stateDir)
    commandMarker = "dev-server-runner.ps1"
    processStartedAtUtc = $info.CreatedAtUtc.ToString("o")
    createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-YuviProcessMetadata -Path $metadataPath -Metadata $fakeMetadata

  $ownership = Test-YuviProcessOwnership -MetadataPath $metadataPath -ExpectedRole "server" -RepositoryRoot $RepoRoot -StateDirectory $stateDir
  if ($ownership.Owned -or $ownership.Status -ne "mismatch") {
    throw "Expected fake metadata to be rejected, got status=$($ownership.Status) owned=$($ownership.Owned)."
  }

  Stop-YuviOwnedProcess -Name "Fake server" -MetadataPath $metadataPath -ExpectedRole "server" -RepositoryRoot $RepoRoot -StateDirectory $stateDir | Out-Null
  if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    throw "Ownership helper stopped an unrelated process."
  }

  Write-Host "Process ownership regression passed."
} finally {
  if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
