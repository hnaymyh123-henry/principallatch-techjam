[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location -LiteralPath $repoDirectory

$runtimeImage = if ($env:CONTAINER_RUNTIME_IMAGE) { $env:CONTAINER_RUNTIME_IMAGE } else { "principallatch-agent-runtime:local" }
$runtimeBaseImage = if ($env:CONTAINER_RUNTIME_BASE_IMAGE) { $env:CONTAINER_RUNTIME_BASE_IMAGE } else { "node:22-bookworm-slim" }
$runtimeAptMirror = if ($env:CONTAINER_APT_MIRROR) { $env:CONTAINER_APT_MIRROR } else { "" }
$runtimeAptSecurityMirror = if ($env:CONTAINER_APT_SECURITY_MIRROR) { $env:CONTAINER_APT_SECURITY_MIRROR } else { "" }
$runtimeAptPackages = if ($env:CONTAINER_RUNTIME_APT_PACKAGES) { $env:CONTAINER_RUNTIME_APT_PACKAGES } else { "ca-certificates git ripgrep" }
$codexSandboxMode = if ($env:CODEX_SANDBOX_MODE) { $env:CODEX_SANDBOX_MODE } else { "workspace-write" }
$engineCommand = $null
$engineKind = $null
$cleanupArmed = $false
$exitCode = 0

function Write-LocalPocLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  [Console]::Error.WriteLine("[local-poc] $Message")
}

function Resolve-Executable {
  param([Parameter(Mandatory = $true)][string]$Name)
  $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  return $command.Source
}

function Test-Engine {
  param([Parameter(Mandatory = $true)][string]$Command)
  & $Command info *> $null
  return $LASTEXITCODE -eq 0
}

function Find-ContainerEngine {
  if ($env:CONTAINER_ENGINE) {
    $explicit = Resolve-Executable -Name $env:CONTAINER_ENGINE
    if ($null -eq $explicit) {
      throw "CONTAINER_ENGINE=$($env:CONTAINER_ENGINE) was not found."
    }
    if (-not (Test-Engine -Command $explicit)) {
      throw "$($env:CONTAINER_ENGINE) is installed but its service is not running."
    }
    return $explicit
  }

  foreach ($candidate in @("docker", "podman")) {
    $resolved = Resolve-Executable -Name $candidate
    if ($null -eq $resolved) { continue }
    if (Test-Engine -Command $resolved) { return $resolved }
    Write-LocalPocLog "$candidate is installed but its service or machine is not running."
  }

  throw "No running Docker or Podman engine was found. Install and start one, then rerun this command."
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)."
  }
}

function Get-RuntimeContainerIds {
  $arguments = @(
    "ps", "--all", "--quiet",
    "--filter", "label=io.codejam.principallatch=agent-runtime",
    "--filter", "label=io.codejam.instance-id=$($env:RUNTIME_INSTANCE_ID)"
  )
  $output = & $script:engineCommand @arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not list Agent Runtime containers for $($env:RUNTIME_INSTANCE_ID)."
  }
  return @($output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

function Remove-RuntimeContainers {
  param([Parameter(Mandatory = $true)][string]$Phase)
  try {
    $failed = $false
    $containerIds = @(Get-RuntimeContainerIds)
    if ($containerIds.Count -gt 0) {
      Write-LocalPocLog "Removing $Phase Agent Runtime containers for $($env:RUNTIME_INSTANCE_ID)."
      foreach ($containerId in $containerIds) {
        & $script:engineCommand rm --force $containerId *> $null
        if ($LASTEXITCODE -ne 0) {
          Write-LocalPocLog "Failed to remove Agent Runtime container $containerId."
          $failed = $true
        }
      }
    }

    $remainingIds = @(Get-RuntimeContainerIds)
    if ($remainingIds.Count -gt 0) {
      Write-LocalPocLog "Agent Runtime cleanup is incomplete; containers remain for $($env:RUNTIME_INSTANCE_ID)."
      $failed = $true
    }
    return -not $failed
  } catch {
    Write-LocalPocLog $_.Exception.Message
    return $false
  }
}

try {
  if (-not $env:ARK_API_KEY -or -not $env:ARK_MODEL -or -not $env:APP_AUTH_TOKEN) {
    throw "ARK_API_KEY, ARK_MODEL, and APP_AUTH_TOKEN are required. APP_AUTH_TOKEN must contain 24-128 URL-safe characters."
  }
  if ($env:ARK_API_KEY.StartsWith("replace-") -or $env:ARK_MODEL.Contains("replace-")) {
    throw "ARK_API_KEY and ARK_MODEL must not be placeholder values."
  }
  if ($env:APP_AUTH_TOKEN -ceq $env:ARK_API_KEY) {
    throw "APP_AUTH_TOKEN and ARK_API_KEY must be independently generated secrets."
  }
  if (
    $env:APP_AUTH_TOKEN.Length -lt 24 -or
    $env:APP_AUTH_TOKEN.Length -gt 128 -or
    $env:APP_AUTH_TOKEN -notmatch '^[A-Za-z0-9._~-]+$' -or
    $env:APP_AUTH_TOKEN.StartsWith("replace-")
  ) {
    throw "APP_AUTH_TOKEN must contain 24-128 URL-safe characters and must not be a placeholder."
  }
  if ($env:CONTAINER_USER -and $env:CONTAINER_USER -match '^(?:0+|root)(?::|$)') {
    throw "PrincipalLatch requires a non-root CONTAINER_USER for the Agent Runtime."
  }

  $nodeCommand = Resolve-Executable -Name "node"
  $npmCommand = Resolve-Executable -Name "npm.cmd"
  if ($null -eq $npmCommand) { $npmCommand = Resolve-Executable -Name "npm" }
  if ($null -eq $nodeCommand) { throw "Node.js 22+ is required to run the local control plane." }
  if ($null -eq $npmCommand) { throw "npm is required to build and run the local control plane." }

  # Keep this expression quote-free: Windows PowerShell 5.1 strips nested
  # quotes while serializing native-process arguments.
  $nodeMajor = & $nodeCommand -p 'parseInt(process.versions.node)'
  if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 22) {
    throw "Node.js 22+ is required; found $(& $nodeCommand --version)."
  }

  $engineCommand = Find-ContainerEngine
  $engineBaseName = [System.IO.Path]::GetFileNameWithoutExtension($engineCommand).ToLowerInvariant()
  if ($engineBaseName -notin @("docker", "podman")) {
    throw "CONTAINER_ENGINE must resolve to Docker or Podman."
  }
  $engineKind = $engineBaseName
  Write-LocalPocLog "Using $engineKind as the disposable Agent Runtime engine."

  # The server invokes the normalized engine name. Always put the directory of
  # the exact executable that passed preflight first in this process's PATH;
  # otherwise an unrelated docker/podman earlier in PATH could be selected.
  $engineDirectory = Split-Path -Parent $engineCommand
  $env:PATH = "$engineDirectory$([System.IO.Path]::PathSeparator)$($env:PATH)"

  if ($env:RUNTIME_INSTANCE_ID) {
    if ($env:RUNTIME_INSTANCE_ID.Length -gt 48 -or $env:RUNTIME_INSTANCE_ID -notmatch '^[A-Za-z0-9_.-]+$') {
      throw "RUNTIME_INSTANCE_ID must contain 1-48 letters, digits, dots, underscores, or hyphens."
    }
  } else {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $repoHash = [System.BitConverter]::ToString(
        $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($repoDirectory.ToLowerInvariant()))
      ).Replace("-", "").Substring(0, 12).ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
    $env:RUNTIME_INSTANCE_ID = "local-win-$repoHash"
  }

  # A stale Runtime may still hold a provider credential. Do not start the host
  # control plane unless every Runtime from this POC instance is gone.
  $cleanupArmed = $true
  if (-not (Remove-RuntimeContainers -Phase "stale")) {
    throw "SECURITY ERROR: stale Agent Runtime cleanup failed; startup is blocked."
  }

  if (-not (Test-Path -LiteralPath (Join-Path $repoDirectory "node_modules") -PathType Container)) {
    Write-LocalPocLog "Installing application dependencies."
    Invoke-NativeChecked -Command $npmCommand -Arguments @("ci") -FailureMessage "Dependency installation failed"
  }

  if ($env:LOCAL_POC_DATA_ROOT) {
    $localStateRoot = [System.IO.Path]::GetFullPath($env:LOCAL_POC_DATA_ROOT)
    $env:APP_DATA_DIR = Join-Path $localStateRoot "data"
    $env:AGENT_WORKSPACE_ROOT = Join-Path $localStateRoot "workspaces"
    $env:CODEX_HOME = Join-Path $localStateRoot "codex-home"
  } else {
    $localStateRoot = Join-Path $repoDirectory ".local"
    $env:APP_DATA_DIR = [System.IO.Path]::GetFullPath($(if ($env:APP_DATA_DIR) { $env:APP_DATA_DIR } else { Join-Path $localStateRoot "data" }))
    $env:AGENT_WORKSPACE_ROOT = [System.IO.Path]::GetFullPath($(if ($env:AGENT_WORKSPACE_ROOT) { $env:AGENT_WORKSPACE_ROOT } else { Join-Path $localStateRoot "workspaces" }))
    $env:CODEX_HOME = [System.IO.Path]::GetFullPath($(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $localStateRoot "codex-home" }))
  }

  foreach ($mountPath in @($env:AGENT_WORKSPACE_ROOT, $env:CODEX_HOME)) {
    if ($mountPath.Contains(",") -or $mountPath.Contains("`n") -or $mountPath.Contains("`r")) {
      throw "Container mount paths must not contain commas or newlines: $mountPath"
    }
  }

  foreach ($directory in @($env:APP_DATA_DIR, $env:AGENT_WORKSPACE_ROOT, $env:CODEX_HOME)) {
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  Write-LocalPocLog "Persistent state: $localStateRoot"
  if (-not $env:CONTAINER_USER) { $env:CONTAINER_USER = "1000:1000" }

  Write-LocalPocLog "Building $runtimeImage from Dockerfile.runtime (base: $runtimeBaseImage)."
  $buildArguments = @(
    "build", "--file", "Dockerfile.runtime",
    "--build-arg", "NODE_IMAGE=$runtimeBaseImage",
    "--build-arg", "DEBIAN_MIRROR=$runtimeAptMirror",
    "--build-arg", "DEBIAN_SECURITY_MIRROR=$runtimeAptSecurityMirror",
    "--build-arg", "RUNTIME_APT_PACKAGES=$runtimeAptPackages",
    "--tag", $runtimeImage, "."
  )
  Invoke-NativeChecked -Command $engineCommand -Arguments $buildArguments -FailureMessage "Runtime image build failed"

  $runtimeLabels = @(
    "--label", "io.codejam.principallatch=agent-runtime",
    "--label", "io.codejam.instance-id=$($env:RUNTIME_INSTANCE_ID)"
  )
  $preflightUserArguments = @("--user", $env:CONTAINER_USER)
  if ($engineKind -eq "podman") { $preflightUserArguments += @("--userns", "keep-id") }

  Write-LocalPocLog "Checking that the Runtime can bind-mount the configured state directories."
  $preflightArguments = @("run", "--rm") + $runtimeLabels + $preflightUserArguments + @(
    "--mount", "type=bind,src=$($env:AGENT_WORKSPACE_ROOT),dst=/workspace",
    "--mount", "type=bind,src=$($env:CODEX_HOME),dst=/codex-home",
    $runtimeImage, "sh", "-lc",
    "touch /workspace/.principallatch-write-test /codex-home/.principallatch-write-test && rm /workspace/.principallatch-write-test /codex-home/.principallatch-write-test"
  )
  & $engineCommand @preflightArguments
  if ($LASTEXITCODE -ne 0) {
    throw "The container engine cannot mount $localStateRoot. Set LOCAL_POC_DATA_ROOT to a directory shared with Docker or Podman."
  }

  if ($codexSandboxMode -eq "workspace-write") {
    $sandboxArguments = @("run", "--rm") + $runtimeLabels + @(
      $runtimeImage, "codex", "sandbox", "linux", "--full-auto", "--", "true"
    )
    & $engineCommand @sandboxArguments *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-LocalPocLog "Codex Landlock is unavailable in this Linux Runtime."
      Write-LocalPocLog "Falling back to danger-full-access inside the disposable container boundary."
      Write-LocalPocLog "Do not mount unrelated secrets or host directories into the Agent Runtime."
      $codexSandboxMode = "danger-full-access"
    }
  }

  $env:NODE_ENV = "production"
  # The disposable bridge Runtime must reach the Passport-only /v1 gateway.
  # Human /api routes remain protected by APP_AUTH_TOKEN plus opaque sessions.
  if (-not $env:HOST) { $env:HOST = "0.0.0.0" }
  if (-not $env:PORT) { $env:PORT = "3000" }
  $env:CODEX_SANDBOX_MODE = $codexSandboxMode
  $env:RUNTIME_PROVIDER = "container"
  $env:CONTAINER_ENGINE = $engineKind
  $env:CONTAINER_RUNTIME_IMAGE = $runtimeImage

  Write-LocalPocLog "Building the local Web and trusted host API."
  Invoke-NativeChecked -Command $npmCommand -Arguments @("run", "build") -FailureMessage "Application build failed"

  Write-LocalPocLog "Open http://localhost:$($env:PORT)"
  & $npmCommand start
  if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
} catch {
  Write-LocalPocLog $_.Exception.Message
  if ($exitCode -eq 0) { $exitCode = 2 }
} finally {
  if ($cleanupArmed -and -not (Remove-RuntimeContainers -Phase "shutdown")) {
    Write-LocalPocLog "SECURITY ERROR: shutdown cleanup failed; inspect the engine before reusing this POC."
    if ($exitCode -eq 0) { $exitCode = 1 }
  }
}

exit $exitCode
