param(
    [ValidateRange(1, 65535)][int]$Port = 8390,
    [string]$TraceRoot = 'demo/traces',
    [string]$RunnerRoot = 'demo/runner',
    [string]$Distribution = 'Ubuntu'
)
$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
if (!(Test-Path -LiteralPath (Join-Path $projectDir 'web-ui/dist/index.html'))) {
    throw 'Build the frontend first: cd web-ui; npm ci; npm run build'
}
function Convert-ReplayPath([string]$Path) {
    $absolutePath = if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $projectDir $Path }
    $converted = & wsl.exe -d $Distribution -e wslpath -a -u $absolutePath
    if ($LASTEXITCODE -ne 0) { throw "Cannot convert the WSL path: $Path" }
    return ($converted | Out-String).Trim()
}
$linuxProject = Convert-ReplayPath $projectDir
$linuxTrace = Convert-ReplayPath $TraceRoot
$linuxRunner = Convert-ReplayPath $RunnerRoot
& wsl.exe -d $Distribution --cd $linuxProject -e bash scripts/serve_replay.sh $Port $linuxTrace $linuxRunner
exit $LASTEXITCODE
