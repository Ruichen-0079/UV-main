$YuviProcessMetadataVersion = 1

function Get-YuviProcessInfo {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $null }

  $createdAtUtc = $null
  if ($process.CreationDate) {
    if ($process.CreationDate -is [datetime]) {
      $createdAtUtc = $process.CreationDate.ToUniversalTime()
    } else {
      $createdAtUtc = ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate)).ToUniversalTime()
    }
  }

  [pscustomobject]@{
    ProcessId = [int]$process.ProcessId
    ParentProcessId = [int]$process.ParentProcessId
    CommandLine = [string]$process.CommandLine
    CreatedAtUtc = $createdAtUtc
  }
}

function ConvertTo-YuviCanonicalPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    return ([System.IO.Path]::GetFullPath($Path)).TrimEnd("\", "/")
  } catch {
    return $Path.TrimEnd("\", "/")
  }
}

function New-YuviProcessMetadata {
  param(
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [Parameter(Mandatory = $true)][string]$CommandMarker
  )

  $processInfo = Get-YuviProcessInfo -ProcessId $ProcessId
  if (-not $processInfo) {
    throw "Process $ProcessId is not running."
  }

  [pscustomobject]@{
    schemaVersion = $script:YuviProcessMetadataVersion
    role = $Role
    pid = $ProcessId
    repositoryRoot = ConvertTo-YuviCanonicalPath -Path $RepositoryRoot
    stateDirectory = ConvertTo-YuviCanonicalPath -Path $StateDirectory
    commandMarker = $CommandMarker
    processStartedAtUtc = $processInfo.CreatedAtUtc.ToString("o")
    createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Write-YuviProcessMetadata {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Metadata
  )

  $directory = Split-Path -Parent $Path
  if ($directory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  $Metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-YuviProcessMetadata {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Encoding UTF8 -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function New-YuviOwnershipResult {
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $true)][bool]$Owned,
    [int]$ProcessId = 0,
    [string]$Message = "",
    $Metadata = $null,
    $ProcessInfo = $null
  )

  [pscustomobject]@{
    Status = $Status
    Owned = $Owned
    ProcessId = $ProcessId
    Message = $Message
    Metadata = $Metadata
    ProcessInfo = $ProcessInfo
  }
}

function Test-YuviProcessOwnership {
  param(
    [Parameter(Mandatory = $true)][string]$MetadataPath,
    [Parameter(Mandatory = $true)][string]$ExpectedRole,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$StateDirectory
  )

  if (-not (Test-Path -LiteralPath $MetadataPath)) {
    return New-YuviOwnershipResult -Status "missing" -Owned $false -Message "metadata missing"
  }

  $metadata = Read-YuviProcessMetadata -Path $MetadataPath
  if (-not $metadata) {
    return New-YuviOwnershipResult -Status "invalid" -Owned $false -Message "metadata is not valid JSON"
  }

  if ([int]$metadata.schemaVersion -ne $script:YuviProcessMetadataVersion) {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -Metadata $metadata -Message "schema version mismatch"
  }
  if ([string]$metadata.role -ne $ExpectedRole) {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -Metadata $metadata -Message "role mismatch"
  }

  $expectedRepoRoot = ConvertTo-YuviCanonicalPath -Path $RepositoryRoot
  $actualRepoRoot = ConvertTo-YuviCanonicalPath -Path ([string]$metadata.repositoryRoot)
  if (-not [string]::Equals($expectedRepoRoot, $actualRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -Metadata $metadata -Message "repository root mismatch"
  }

  $expectedStateDirectory = ConvertTo-YuviCanonicalPath -Path $StateDirectory
  $actualStateDirectory = ConvertTo-YuviCanonicalPath -Path ([string]$metadata.stateDirectory)
  if (-not [string]::Equals($expectedStateDirectory, $actualStateDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -Metadata $metadata -Message "state directory mismatch"
  }

  $processIdValue = 0
  if (-not [int]::TryParse([string]$metadata.pid, [ref]$processIdValue) -or $processIdValue -le 0) {
    return New-YuviOwnershipResult -Status "invalid" -Owned $false -Metadata $metadata -Message "pid invalid"
  }

  $processInfo = Get-YuviProcessInfo -ProcessId $processIdValue
  if (-not $processInfo) {
    return New-YuviOwnershipResult -Status "stale" -Owned $false -ProcessId $processIdValue -Metadata $metadata -Message "process is not running"
  }

  $marker = [string]$metadata.commandMarker
  if ([string]::IsNullOrWhiteSpace($marker) -or $processInfo.CommandLine -notlike "*$marker*") {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -ProcessId $processIdValue -Metadata $metadata -ProcessInfo $processInfo -Message "command marker mismatch"
  }

  if ($processInfo.CommandLine -notlike "*$expectedRepoRoot*") {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -ProcessId $processIdValue -Metadata $metadata -ProcessInfo $processInfo -Message "repository root not present in command line"
  }

  $metadataStartedAt = [datetime]::MinValue
  if (-not [datetime]::TryParse([string]$metadata.processStartedAtUtc, [ref]$metadataStartedAt)) {
    return New-YuviOwnershipResult -Status "invalid" -Owned $false -ProcessId $processIdValue -Metadata $metadata -ProcessInfo $processInfo -Message "start time invalid"
  }
  $metadataStartedAt = $metadataStartedAt.ToUniversalTime()
  if ([math]::Abs(($processInfo.CreatedAtUtc - $metadataStartedAt).TotalSeconds) -gt 2) {
    return New-YuviOwnershipResult -Status "mismatch" -Owned $false -ProcessId $processIdValue -Metadata $metadata -ProcessInfo $processInfo -Message "start time mismatch"
  }

  return New-YuviOwnershipResult -Status "running" -Owned $true -ProcessId $processIdValue -Metadata $metadata -ProcessInfo $processInfo -Message "owned process is running"
}

function Remove-YuviInvalidMetadata {
  param(
    [Parameter(Mandatory = $true)]$Ownership,
    [Parameter(Mandatory = $true)][string]$MetadataPath
  )

  if (-not $Ownership.Owned -and $Ownership.Status -ne "missing") {
    Remove-Item -LiteralPath $MetadataPath -Force -ErrorAction SilentlyContinue
  }
}

function Stop-YuviProcessTreeByPid {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-YuviProcessTreeByPid -ProcessId ([int]$child.ProcessId)
  }

  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Stop-YuviOwnedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$MetadataPath,
    [Parameter(Mandatory = $true)][string]$ExpectedRole,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$StateDirectory
  )

  $ownership = Test-YuviProcessOwnership -MetadataPath $MetadataPath -ExpectedRole $ExpectedRole -RepositoryRoot $RepositoryRoot -StateDirectory $StateDirectory
  if ($ownership.Owned) {
    Write-Host "Stopping $Name process tree, PID $($ownership.ProcessId)."
    Stop-YuviProcessTreeByPid -ProcessId ([int]$ownership.ProcessId)
    Remove-Item -LiteralPath $MetadataPath -Force -ErrorAction SilentlyContinue
    return $true
  }

  if ($ownership.Status -eq "missing") {
    Write-Host "$Name metadata not found; skipping."
  } else {
    Write-Host "$Name metadata is $($ownership.Status): $($ownership.Message). Not stopping unrelated process."
    Remove-YuviInvalidMetadata -Ownership $ownership -MetadataPath $MetadataPath
  }
  return $false
}
