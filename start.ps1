$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$bundledNodeDirectory = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$installedNode = Get-Command node -ErrorAction SilentlyContinue
$hasSupportedNode = $false
if ($installedNode) {
    $nodeVersionParts = (& $installedNode.Source --version).TrimStart('v').Split('.')
    $majorVersion = [int]$nodeVersionParts[0]
    $minorVersion = [int]$nodeVersionParts[1]
    $hasSupportedNode = ($majorVersion -gt 22) -or ($majorVersion -eq 22 -and $minorVersion -ge 12)
}
if (-not $hasSupportedNode) {
    $bundledNode = Join-Path $bundledNodeDirectory 'node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $env:Path = "$bundledNodeDirectory;$env:Path" }
    else { throw 'CloudMedia requires Node.js 22.12+ or 24 LTS. Please install Node.js first.' }
}
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Created .env; configure DATABASE_URL to use PostgreSQL.'
}
if (-not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
& node --import tsx server/index.ts
