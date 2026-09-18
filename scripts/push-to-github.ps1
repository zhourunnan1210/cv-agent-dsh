# 把本仓库推到 GitHub（`cv-agent-dsh`）
#
# 为什么需要这个脚本：推送要有 GitHub 凭据，而那一步必须由你本人授权
# （本机 `gh` 的 token 已失效，四个 SSH 密钥也都没授权给 GitHub）。
# 授权之后，这条脚本把剩下的事一次做完。
#
# 用法：
#   1) 先授权（二选一）
#        gh auth login                          # 浏览器/设备码，推荐
#        # 或者把一个 PAT 放进环境变量：$env:GH_TOKEN='ghp_xxx'
#   2) 再跑本脚本
#        pwsh -File scripts/push-to-github.ps1                 # 默认建**私有**仓库
#        pwsh -File scripts/push-to-github.ps1 -Visibility public
#
# 脚本是**幂等**的：仓库已存在就用现成的，远程已配好就不重复配，已经推过就只推增量。

[CmdletBinding()]
param(
    [ValidateSet('private', 'public')]
    [string]$Visibility = 'private',

    [string]$Owner = 'zhourunnan1210',
    [string]$Repo = 'cv-agent-dsh'
)

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }

# ── 0. 前置检查 ───────────────────────────────────────────────────────────
Step '检查前置'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git 不在 PATH 里' }
if (-not (Get-Command gh  -ErrorAction SilentlyContinue)) { throw 'gh 不在 PATH 里（https://cli.github.com/）' }

$root = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw '当前目录不是 git 仓库' }
Set-Location $root
Ok "仓库根：$root"

# 未提交的改动：先提醒（不擅自 commit——那属于你的决定）
$dirty = git status --porcelain
if ($dirty) {
    Warn '有未提交的改动，它们不会被推上去：'
    $dirty | Select-Object -First 10 | ForEach-Object { Warn "  $_" }
} else {
    Ok '工作区干净'
}

# 认证状态
Step '检查 GitHub 认证'
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '未通过认证。先执行其中一条，再重跑本脚本：' -ForegroundColor Yellow
    Write-Host '    gh auth login' -ForegroundColor White
    Write-Host "    `$env:GH_TOKEN='<你的 PAT>'" -ForegroundColor White
    exit 1
}
$account = (gh api user --jq .login 2>$null)
Ok "已认证为：$account"

# ── 1. 建仓库（已存在则复用）─────────────────────────────────────────────
Step "确认远程仓库 $Owner/$Repo"
$exists = gh repo view "$Owner/$Repo" --json name 2>$null
if ($LASTEXITCODE -eq 0 -and $exists) {
    Ok '仓库已存在，复用'
} else {
    gh repo create "$Owner/$Repo" --$Visibility --description '面向计算机视觉领域的自主科研 Agent 平台（DeepSeek Harness 插件）'
    if ($LASTEXITCODE -ne 0) { throw "建仓库失败（$Visibility）" }
    Ok "已创建（$Visibility）"
}

# ── 2. 配远程 ─────────────────────────────────────────────────────────────
Step '配置 remote'
$url = "https://github.com/$Owner/$Repo.git"
$current = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
    git remote add origin $url
    Ok "已添加 origin -> $url"
} elseif ($current -ne $url) {
    Warn "origin 当前是 $current，改为 $url"
    git remote set-url origin $url
} else {
    Ok "origin 已是 $url"
}

# ── 3. 推送 ───────────────────────────────────────────────────────────────
$branch = git rev-parse --abbrev-ref HEAD
Step "推送 $branch（仓库约 390MB，首次推送可能要几分钟）"
git push -u origin $branch

Write-Host ''
Write-Host "完成：https://github.com/$Owner/$Repo" -ForegroundColor Green
if ($Visibility -eq 'private') {
    Write-Host '当前是私有仓库。要公开：Settings → General → Danger Zone → Change visibility' -ForegroundColor DarkGray
}
