<#
.SYNOPSIS
  把 dsh-clarify（澄清模式）装进一个 DSH profile。

.DESCRIPTION
  三件事，都可以先 -DryRun 看一遍：
    1. 把插件源码拷到 -Target（默认 E:\dsh-env\plugins-local\dsh-clarify）；
    2. 在 profile 里 pnpm add 'link:<Target>'；
    3. 把 "dsh-clarify" 补进 package.json 的 dsh.profile.bundles
       （漏了这一步，插件装了也不会被组合进来，而且不会报错）。

  装完必须完全退出并重新打开 DeepSeek Harness 才生效。

.EXAMPLE
  .\install.ps1 -DryRun
  .\install.ps1
  .\install.ps1 -Profile "E:\dsh\profiles\desktop" -Target "E:\dsh-env\plugins-local\dsh-clarify"
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [string]$Target = 'E:\dsh-env\plugins-local\dsh-clarify',
  [switch]$DryRun,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$pluginName = 'dsh-clarify'
$sourceManifest = Join-Path $here 'package.json'
$addBundle = Join-Path $here 'tools\add-bundle.mjs'

if (-not (Test-Path -LiteralPath $sourceManifest)) {
  throw "找不到插件源码（缺 package.json）。请把 install.ps1 和 lib\ 放在同一个目录里运行。"
}
if (-not (Test-Path -LiteralPath $addBundle)) {
  throw "找不到 tools\add-bundle.mjs，源码不完整。"
}

# ---- 找 profile ----
if (-not $Profile) {
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    (Join-Path $env:USERPROFILE '.dsh\profiles\web'),
    'E:\dsh\profiles\desktop'
  )
  $Profile = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'package.json') } | Select-Object -First 1
}
if (-not $Profile) {
  throw "找不到 DSH profile。用 -Profile 指定，例如：-Profile `"$env:USERPROFILE\.dsh\profiles\desktop`""
}
$profileManifest = Join-Path $Profile 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest)) { throw "这个目录里没有 package.json，不像是 DSH profile：$Profile" }

$profileJson = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $profileJson.dsh -or -not $profileJson.dsh.profile) {
  throw "profile 的 package.json 里没有 dsh.profile，不像是 DSH profile：$Profile"
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "没找到 node。装一个 Node.js 22+，或让 DSH 自带的 node 进 PATH。" }
if (-not $pnpmCmd) { throw "没找到 pnpm。先装：npm i -g pnpm" }

$source = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
$resolvedTarget = [System.IO.Path]::GetFullPath($Target)
$samePlace = $resolvedTarget -eq $here

Write-Host "插件     : $pluginName v$($source.version)"
Write-Host "源码     : $here"
Write-Host "目标     : $resolvedTarget"
Write-Host "profile  : $Profile"
Write-Host "模式     : $(if ($DryRun) { '试运行（不改任何东西）' } elseif ($Uninstall) { '卸载' } else { '安装' })"
Write-Host ""

# ---- 卸载 ----
if ($Uninstall) {
  if ($DryRun) {
    Write-Host "[dry] cd `"$Profile`" ; pnpm remove $pluginName"
    Write-Host "[dry] node `"$addBundle`" `"$profileManifest`" $pluginName --remove"
    return
  }
  Push-Location -LiteralPath $Profile
  try {
    & pnpm remove $pluginName
    if ($LASTEXITCODE -ne 0) { throw "pnpm remove 失败（退出码 $LASTEXITCODE）" }
  }
  finally {
    Pop-Location
  }
  & node $addBundle $profileManifest $pluginName --remove
  if ($LASTEXITCODE -ne 0) { throw "从 dsh.profile.bundles 里移除失败" }
  Write-Host ""
  Write-Host "已从 profile 移除；源码目录 $resolvedTarget 保留着，想装回来再跑一次本脚本。"
  Write-Host "完全退出并重新打开 DeepSeek Harness 才会生效。"
  return
}

# ---- 1. 拷源码 ----
if ($samePlace) {
  Write-Host "== 源码就在目标目录，跳过拷贝"
}
elseif ($DryRun) {
  Write-Host "== [dry] 拷源码 -> $resolvedTarget（lib, tools, package.json, cordis.patch.yml, README.md）"
}
else {
  New-Item -ItemType Directory -Force -Path $resolvedTarget | Out-Null
  foreach ($item in @('lib', 'tools', 'package.json', 'cordis.patch.yml', 'README.md')) {
    $from = Join-Path $here $item
    if (-not (Test-Path -LiteralPath $from)) { throw "源码里缺 $item" }
    Copy-Item -LiteralPath $from -Destination (Join-Path $resolvedTarget $item) -Recurse -Force
  }
  Write-Host "== 已拷到 $resolvedTarget"
}

# ---- 2. 链进 profile ----
$linkSpec = 'link:' + ($resolvedTarget -replace '\\', '/')
if ($DryRun) {
  Write-Host "== [dry] cd `"$Profile`" ; pnpm add `"$linkSpec`""
}
else {
  Push-Location -LiteralPath $Profile
  try {
    & pnpm add $linkSpec
    if ($LASTEXITCODE -ne 0) { throw "pnpm add 失败（退出码 $LASTEXITCODE）" }
  }
  finally {
    Pop-Location
  }
  Write-Host "== 已把 $pluginName 链进 profile"
}

# ---- 3. 补进 bundles ----
if ($DryRun) {
  & node $addBundle $profileManifest $pluginName --dry-run
  if ($LASTEXITCODE -ne 0) { throw "检查 dsh.profile.bundles 失败" }
}
else {
  $backup = "$profileManifest.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item -LiteralPath $profileManifest -Destination $backup -Force
  $output = & node $addBundle $profileManifest $pluginName
  if ($LASTEXITCODE -ne 0) { throw "更新 dsh.profile.bundles 失败（备份在 $backup）" }
  $result = ($output -join '') | ConvertFrom-Json
  if (@($result.changed).Count -gt 0) {
    Write-Host "== 已把 $($result.changed -join ', ') 追加到 dsh.profile.bundles（备份：$(Split-Path -Leaf $backup)）"
  }
  else {
    Write-Host "== dsh.profile.bundles 里已经有了，没改动"
  }
}

Write-Host ""
Write-Host "完成。完全退出并重新打开 DeepSeek Harness，输入框右侧会出现「澄清」。"
Write-Host "自检：Invoke-RestMethod http://127.0.0.1:3042/api/clarify/health"
