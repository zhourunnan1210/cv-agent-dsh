<#
.SYNOPSIS
    启动 cv-research 的 dsh web 宿主，并注入本项目必需的环境前置。

.DESCRIPTION
    这个脚本存在的唯一理由是：有些前置**只能由宿主进程的环境提供**，靠仓库里的
    配置文件补不上。漏掉它们的后果不是报错，而是「工具静默消失」——本项目最忌讳
    的失败模式。具体三件事：

    1. 代理：Asta MCP 的 transport 是 fetch。Node 24 的 global fetch **必须**
       同时有 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1 才会走代理（实测：只有前者 = 403）。
       NO_PROXY 三个国内域名也必需（mineru.net / aliyuncs.com / openxlab.org.cn）——
       漏一个，代理一挂就在解析链路的某一步全废（勘误 E26）。
    2. 密钥：从 .env.local 读入宿主环境（gitignore 覆盖）。
    3. skill 根：把 skill 目录钉成绝对路径，与「会话工作区」解耦（否则换工作区
       跑科研项目时 skill 全部消失，且不报错）。

    编码注意（2026-09-17 实测的启动失败根因）：本文件含中文，**必须带 UTF-8 BOM**。
    Windows PowerShell 5.1 读无 BOM 的 .ps1 时按 ANSI/GBK 解码，中文变乱码，
    乱码字节会吃掉字符串引号 → **解析期直接报错**，脚本一行都不会执行。
    改本文件时不要丢掉 BOM。

.PARAMETER Port
    宿主端口，默认 3080。

.PARAMETER DryRun
    只做前置检查与预检，不启动宿主。改环境/排查时先用它。

.EXAMPLE
    powershell -NoProfile -File scripts\start-dsh-web.ps1 -DryRun
    powershell -NoProfile -File scripts\start-dsh-web.ps1
#>
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
# 国内服务直连，别绕代理（Node 的 EnvHttpProxyProxy 认 NO_PROXY）。
# aliyuncs.com / openxlab.org.cn 是 MinerU 链路的必需项，不是顺手加的（勘误 E26）。
$env:NO_PROXY = 'localhost,127.0.0.1,::1,mineru.net,aliyuncs.com,openxlab.org.cn,pypi.tuna.tsinghua.edu.cn,mirrors.aliyun.com,api.deepseek.com'
$env:no_proxy = $env:NO_PROXY

# ── 1b. skill 根：让 skill 与「会话工作区」解耦 ─────────────────────────────
# dsh 默认只扫描「会话工作区所属项目根」下的 .dsh/skills（rank 100）。换个工作区
# 跑科研项目时就找不到，而且**不报错、只是工具消失**。这两个变量把 skill 根钉死
# 成绝对路径，与工作区无关；cv-research preset 的 skill-filesystem 行会读它们：
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
Write-Host ("  仓库根               = {0}" -f $repoRoot)
Write-Host ("  HTTPS_PROXY          = {0}" -f $env:HTTPS_PROXY)
Write-Host ("  NODE_USE_ENV_PROXY   = {0}" -f $env:NODE_USE_ENV_PROXY)
Write-Host ("  NO_PROXY             = {0}" -f $env:NO_PROXY)

if ($env:ASTA_API_KEY) {
    Write-Host ("  ASTA_API_KEY         = 已设置（{0}…，长度 {1}）" -f $env:ASTA_API_KEY.Substring(0, [Math]::Min(8, $env:ASTA_API_KEY.Length)), $env:ASTA_API_KEY.Length) -ForegroundColor Green
} else {
    Write-Host '  ASTA_API_KEY         = 缺失' -ForegroundColor Red
    Write-Host '    → 检索工具会静默消失。请在 .env.local 里写 ASTA_API_KEY=<key>（该文件已被 gitignore），' -ForegroundColor Yellow
    Write-Host '      或先设好该环境变量再运行本脚本。模板见 .env.example。' -ForegroundColor Yellow
}

if ($env:MINERU_TOKEN) {
    Write-Host '  MINERU_TOKEN         = 已设置' -ForegroundColor Green
} else {
    Write-Host '  MINERU_TOKEN         = 缺失（解析相关工具不可用；脚本侧解析不受影响）' -ForegroundColor Yellow
}

# skill 根是否真的存在——这条失败是静默的，所以必须显式检查
foreach ($pair in @(
    @{ Name = 'skill 根(项目)'; Path = $env:CV_PROJECT_SKILLS_DIR },
    @{ Name = 'skill 根(插件)'; Path = $env:CV_PLUGIN_SKILLS_DIR }
)) {
    $exists = Test-Path $pair.Path
    $color = if ($exists) { 'Green' } else { 'Red' }
    $suffix = if ($exists) { '' } else { '  ← 不存在：该路径下的 skill 会静默消失' }
    Write-Host ("  {0,-18} = {1}{2}" -f $pair.Name, $pair.Path, $suffix) -ForegroundColor $color
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

# 真实连通性预检：把"key 存在"升级为"key 真的能用"。
# 三种失败（缺 key / 缺代理 flag / 代理没开）都不会阻止宿主启动，只会让 Agent 静默
# 没有检索工具——所以在启动前把它们变成显式结果。
#
# ⚠️ 原生命令 + `2>&1` 在 $ErrorActionPreference='Stop' 下会因 stderr 变成
# ErrorRecord 而**中断整个脚本**（预检失败反而把启动也带崩）。因此这里局部降级为
# Continue，并把异常也当作"预检失败"处理——预检永远不该阻止宿主启动。
if ($env:ASTA_API_KEY -and $listening) {
    Write-Host '  连接 Asta 预检        = ' -NoNewline
    $probeOk = $false
    $probe = @()
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $probe = & node (Join-Path $PSScriptRoot 'check-asta.mjs') 2>&1
        $probeOk = $LASTEXITCODE -eq 0
    } catch {
        $probe = @($_.Exception.Message)
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($probeOk) {
        Write-Host '通过' -ForegroundColor Green
        $probe | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host '失败（宿主仍会启动，但该 Agent 不会有检索工具）' -ForegroundColor Red
        $probe | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    }
}

# 目标端口是否已被占用（宿主已在跑）→ **早退**，别去撞一个注定失败的启动
$busy = (netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING') -ne $null
if ($busy) {
    Write-Host ("  端口 {0}            = 已被占用（宿主可能已在运行）" -f $Port) -ForegroundColor Yellow
    Write-Host '    → 现有宿主仍在提供服务：直接用它即可；要换新宿主，先停掉旧进程再运行本脚本。' -ForegroundColor Yellow
    Write-Host '    → 提示：本脚本注入的前置（代理/密钥/skill 根）只在**由本脚本启动**的宿主里生效。' -ForegroundColor Yellow
    if (-not $DryRun) {
        Write-Host '── 不再尝试启动（避免注定失败的启动）───────────────' -ForegroundColor Cyan
        exit 2
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
