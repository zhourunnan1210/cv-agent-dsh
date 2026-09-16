<#
.SYNOPSIS
    启动 dsh web 宿主，并带上 cv-research 所需的环境变量。

.DESCRIPTION
    `cv-research` preset 里的 `mcp-asta` 行有三个前置条件，缺任何一个都会让
    Agent **静默地没有检索工具**（日志有错，但 preset 照常挂载——`failOnStartupError`
    刻意保持默认 false，网络故障不该让整个 Orchestrator 会话起不来）。

    本脚本把它们固定下来，避免靠记忆：

      1. `HTTPS_PROXY`         —— Asta 域名在本网络被 Google 前置层 403 拦截；
      2. `NODE_USE_ENV_PROXY=1` —— Node 24 的 global fetch **缺这个 flag 会直接忽略
         `HTTPS_PROXY`**，而 MCP transport 正是 fetch。实测：只有代理 = 403，
         代理 + flag = 200；
      3. `ASTA_API_KEY`        —— Asta MCP 的 `x-api-key`。密钥**不写进本仓库**：
         优先取当前环境变量，其次读仓库根下 gitignore 的 `.env.local`。

.PARAMETER Port
    监听端口，默认 3080（与当前 GUI 一致）。

.PARAMETER DryRun
    只打印将要设置的环境变量与自检结果，不启动宿主。

.EXAMPLE
    pwsh -File scripts/start-dsh-web.ps1
    pwsh -File scripts/start-dsh-web.ps1 -DryRun
#>
# ⚠️ 本文件必须保存为 **UTF-8 with BOM**。
# 本机实际使用的 shell 是 Windows PowerShell 5.1（没有 pwsh），它会把**无 BOM** 的
# .ps1 按 ANSI/GBK 解码：中文被撕碎后会**直接导致语法错误**，脚本根本跑不起来。
# 任何编辑本文件的工具（包括 AI agent 的 write / edit）都可能顺手去掉 BOM——改完请确认：
#     [System.IO.File]::ReadAllBytes($p)[0..2]   # 应为 239,187,191
# 需要修复时：
#     $t = [System.IO.File]::ReadAllText($p, [Text.UTF8Encoding]::new($false))
#     [System.IO.File]::WriteAllText($p, $t, [Text.UTF8Encoding]::new($true))
[CmdletBinding()]
param(
    [int]$Port = 3080,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

# ── 1. 代理 ────────────────────────────────────────────────────────────────
$proxyUrl = 'http://127.0.0.1:10808'
$env:HTTPS_PROXY = $proxyUrl
$env:HTTP_PROXY = $proxyUrl
$env:NODE_USE_ENV_PROXY = '1'
# 国内服务直连，别绕代理（Node 的 EnvHttpProxyAgent 认 NO_PROXY）
#
# ⚠️ `aliyuncs.com` 与 `openxlab.org.cn` 是**必需项**，不是顺手加的：
# MinerU 的解析 API 在 mineru.net，但
#   ① 签名上传链接落在 `mineru.oss-cn-shanghai.aliyuncs.com`（阿里云上海 OSS）；
#   ② 解析产物的 zip 落在 `cdn-mineru.openxlab.org.cn`。
# 漏掉任一个，代理一挂，**解析链路就在那一步全废**（实测：漏 ① 时上传 PUT
# ECONNREFUSED 127.0.0.1:10808；漏 ② 时 7 篇全部「fetch failed」，
# 而 MinerU 侧其实已经 done）。这两个端点都是国内直连、根本不需要代理——
# 2026-09-17 实测：API 304ms、OSS PUT 249ms，均 HTTP 200。
$env:NO_PROXY = 'localhost,127.0.0.1,::1,mineru.net,aliyuncs.com,openxlab.org.cn,pypi.tuna.tsinghua.edu.cn,mirrors.aliyun.com,api.deepseek.com'
$env:no_proxy = $env:NO_PROXY

# ── 1b. skill 根：让 skill 与「会话工作区」解耦 ─────────────────────────────
# dsh 默认只扫描「会话工作区所属项目根」下的 .dsh/skills（rank 100）。换个工作区
# 跑科研项目时就找不到，而且**不报错、只是工具消失**——正是本项目最忌讳的失败模式。
# 这两个变量把 skill 根钉死成绝对路径，与工作区无关；cv-research preset 的
# skill-filesystem 行会读它们（见 presets/cv-research/agent.cordis.yml）：
#   CV_PROJECT_SKILLS_DIR  第三方 skill 归档（CCFA / nature / academic-research）
#   CV_PLUGIN_SKILLS_DIR   插件自带的 skill（paper-fetch，随 cv-agent-dsh 分发）
$env:CV_PROJECT_SKILLS_DIR = Join-Path $repoRoot '.dsh\skills'
$env:CV_PLUGIN_SKILLS_DIR = Join-Path $repoRoot 'packages\dsh-plugin\skills'

# ── 2. 密钥：环境变量优先，其次 .env.local（gitignore 覆盖）────────────────
function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    foreach ($line in Get-Content $Path -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $key = $t.Substring(0, $i).Trim()
        $val = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
        if ($val -eq '') { continue }
        if (-not [Environment]::GetEnvironmentVariable($key)) { Set-Item -Path "Env:$key" -Value $val }
    }
}
Import-DotEnv (Join-Path $repoRoot '.env.local')

# ── 3. 自检 ────────────────────────────────────────────────────────────────
Write-Host '── cv-research 前置检查 ─────────────────────────────' -ForegroundColor Cyan
Write-Host ("  HTTPS_PROXY          = {0}" -f $env:HTTPS_PROXY)
Write-Host ("  NODE_USE_ENV_PROXY   = {0}" -f $env:NODE_USE_ENV_PROXY)
if ($env:ASTA_API_KEY) {
    Write-Host ("  ASTA_API_KEY         = 已设置（{0}…，长度 {1}）" -f $env:ASTA_API_KEY.Substring(0, [Math]::Min(8, $env:ASTA_API_KEY.Length)), $env:ASTA_API_KEY.Length) -ForegroundColor Green
} else {
    Write-Host '  ASTA_API_KEY         = 缺失' -ForegroundColor Red
    Write-Host '    → 检索工具会静默消失。请在 .env.local 里写 ASTA_API_KEY=<key>（该文件已被 gitignore），' -ForegroundColor Yellow
    Write-Host '      或先设好该环境变量再运行本脚本。模板见 .env.example。' -ForegroundColor Yellow
}

# 代理是否真的在监听
$proxyPort = ([Uri]$proxyUrl).Port
$listening = (netstat -ano | Select-String ":$proxyPort\s" | Select-String 'LISTENING') -ne $null
if ($listening) {
    Write-Host '  代理端口             = 在监听' -ForegroundColor Green
} else {
    Write-Host ("  代理端口 {0}         = 未监听 → Asta 会 403" -f $proxyPort) -ForegroundColor Red
    Write-Host '    → 先启动你的代理客户端。' -ForegroundColor Yellow
}

# 目标端口是否已被占用（宿主已在跑）
$busy = (netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING') -ne $null
if ($busy) {
    Write-Host ("  端口 {0}            = 已被占用（宿主可能已在运行）" -f $Port) -ForegroundColor Yellow
    Write-Host '    → 请先关闭现有 dsh web 进程再运行本脚本，否则新宿主起不来。' -ForegroundColor Yellow
}

# 真实连通性预检：把"key 存在"升级为"key 真的能用"。
# 三种失败（缺 key / 缺代理 flag / 代理没开）都不会阻止宿主启动，只会让 Agent 静默
# 没有检索工具——所以在启动前把它们变成显式结果。
if ($env:ASTA_API_KEY -and $listening) {
    $probe = & node (Join-Path $PSScriptRoot 'check-asta.mjs') 2>&1
    $probeOk = $LASTEXITCODE -eq 0
    Write-Host '  连接 Asta 预检        = ' -NoNewline
    if ($probeOk) {
        Write-Host '通过' -ForegroundColor Green
        $probe | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host '失败（宿主仍会启动，但该 Agent 不会有检索工具）' -ForegroundColor Red
        $probe | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    }
}

if ($DryRun) {
    Write-Host '── DryRun：不启动宿主 ──────────────────────────────' -ForegroundColor Cyan
    exit 0
}

# ── 4. 启动 ────────────────────────────────────────────────────────────────
Write-Host '── 启动 dsh web ────────────────────────────────────' -ForegroundColor Cyan
Write-Host ("  working dir: {0}" -f $repoRoot)
Push-Location $repoRoot
try {
    if ($Port -eq 3080) { dsh web } else { dsh web --port $Port }
} finally {
    Pop-Location
}
