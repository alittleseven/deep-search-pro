[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$ContainerName = "deep-search-mysql"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $EnvFile) {
    $EnvFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
}

function Read-DotEnv {
    param([Parameter(Mandatory)][string]$Path)

    $settings = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding utf8) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) {
            continue
        }

        $parts = $line.Split("=", 2)
        if ($parts.Count -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $settings[$key] = $value
    }
    return $settings
}

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "Environment file not found: $EnvFile"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found in PATH."
}

$settings = Read-DotEnv -Path $EnvFile
foreach ($requiredKey in @("MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE")) {
    if (-not $settings.ContainsKey($requiredKey) -or -not $settings[$requiredKey]) {
        throw "Missing required setting in .env: $requiredKey"
    }
}

$runningState = & docker inspect --format '{{.State.Running}}' $ContainerName 2>$null
$inspectExitCode = $LASTEXITCODE
if ($inspectExitCode -ne 0 -or "$runningState".Trim() -ne "true") {
    throw "MySQL container is not running: $ContainerName"
}

$sqlPath = Join-Path $PSScriptRoot "init_demo_data.sql"
if (-not (Test-Path -LiteralPath $sqlPath -PathType Leaf)) {
    throw "SQL file not found: $sqlPath"
}

$containerSqlPath = "/tmp/deep_search_init_demo_data.sql"
$oldPassword = [Environment]::GetEnvironmentVariable("MYSQL_PWD", "Process")
$oldUser = [Environment]::GetEnvironmentVariable("DEEP_SEARCH_DB_USER", "Process")
$oldDatabase = [Environment]::GetEnvironmentVariable("DEEP_SEARCH_DB_NAME", "Process")

try {
    [Environment]::SetEnvironmentVariable("MYSQL_PWD", $settings["MYSQL_PASSWORD"], "Process")
    [Environment]::SetEnvironmentVariable("DEEP_SEARCH_DB_USER", $settings["MYSQL_USER"], "Process")
    [Environment]::SetEnvironmentVariable("DEEP_SEARCH_DB_NAME", $settings["MYSQL_DATABASE"], "Process")

    & docker cp $sqlPath "${ContainerName}:$containerSqlPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to copy the SQL file into the MySQL container."
    }

    & docker exec --env MYSQL_PWD --env DEEP_SEARCH_DB_USER --env DEEP_SEARCH_DB_NAME `
        $ContainerName sh -c `
        'mysql --default-character-set=utf8mb4 --user="$DEEP_SEARCH_DB_USER" --database="$DEEP_SEARCH_DB_NAME" < /tmp/deep_search_init_demo_data.sql'
    if ($LASTEXITCODE -ne 0) {
        throw "MySQL initialization failed with exit code $LASTEXITCODE."
    }
}
finally {
    & docker exec $ContainerName rm -f $containerSqlPath 2>$null | Out-Null
    [Environment]::SetEnvironmentVariable("MYSQL_PWD", $oldPassword, "Process")
    [Environment]::SetEnvironmentVariable("DEEP_SEARCH_DB_USER", $oldUser, "Process")
    [Environment]::SetEnvironmentVariable("DEEP_SEARCH_DB_NAME", $oldDatabase, "Process")
}
