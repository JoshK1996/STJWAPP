param(
 [Parameter(Mandatory=$true)][string]$ReleasePath,
 [Parameter(Mandatory=$true)][string]$IdentityFile,
 [Parameter(Mandatory=$true)][string]$KnownHosts,
 [Parameter(Mandatory=$true)][string]$RailwayCli,
 [switch]$DryRun
)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$railway=(Resolve-Path -LiteralPath $RailwayCli).Path
$release=(Resolve-Path -LiteralPath $ReleasePath).Path
$stagingRoot=(Join-Path $workspace '.work')+[IO.Path]::DirectorySeparatorChar
if(-not $release.StartsWith($stagingRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Use a release staged inside this STJW workspace.'}
$manifestPath=$release+'.manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
foreach($entry in $manifest){
 $target=[IO.Path]::GetFullPath((Join-Path $release $entry.path))
 if(-not $target.StartsWith($release+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid staged manifest path.'}
 if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Staged release changed after review.'}
}
$connection=Join-Path $workspace '.work/postgres-maintenance-ssh-config.txt'
& $railway ssh config --project af8e22fa-7eb2-42ed-aa8b-a2a796a612d6 --environment production --service Postgres --identity-file $IdentityFile --dry-run | Set-Content -LiteralPath $connection -Encoding utf8
if($LASTEXITCODE -ne 0){throw 'Railway PostgreSQL connection preparation failed.'}
$sqlPath=Join-Path $workspace '.work/reviewed-maintenance.sql'
& (Join-Path $workspace 'node_modules/.bin/tsx.cmd') (Join-Path $PSScriptRoot 'maintenance-sql.ts') $release | Set-Content -LiteralPath $sqlPath -Encoding utf8
if($LASTEXITCODE -ne 0){throw 'Maintenance plan generation failed.'}
$arguments=@((Join-Path $PSScriptRoot 'railway-maintenance.py'),'--config',$connection,'--identity-file',$IdentityFile,'--known-hosts',$KnownHosts,'--sql',$sqlPath)
if($DryRun){$arguments+='--dry-run'}
& python @arguments
if($LASTEXITCODE -ne 0){throw 'Maintenance failed; do not deploy the web release.'}
