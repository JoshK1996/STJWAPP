$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release = Join-Path $workspace ('.work/release-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $release | Out-Null
# Explicit allowlist: no credentials, local databases, reference copies, or browser state.
$files = @('package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','Dockerfile','.dockerignore')
$folders = @('src','server','shared','public')
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $workspace $file) -Destination $release }
foreach ($folder in $folders) { Copy-Item -LiteralPath (Join-Path $workspace $folder) -Destination $release -Recurse }
New-Item -ItemType Directory -Path (Join-Path $release 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'scripts/test-env.mjs') -Destination (Join-Path $release 'scripts/test-env.mjs')
$manifest = Get-ChildItem -LiteralPath $release -File -Recurse | ForEach-Object {
    [pscustomobject]@{path=$_.FullName.Substring($release.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath ($release + '.manifest.json')
Write-Output $release
