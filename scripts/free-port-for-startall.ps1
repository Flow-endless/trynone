# 供 start-all.bat 在每次 mvn 后调用：先结束本机 8081 上旧 Java，再让新 JAR 启动生效。
# 1) 尝试读取项目根 deepseek-backend.pid（start-backend-hidden 写入）
# 2) 若端口仍被占用，按监听端口强杀（避免「已打包新 JAR 但进程仍用旧 classpath」）
param(
    [int]$Port = 8081,
    [string]$ProjectRoot
)
$ErrorActionPreference = "SilentlyContinue"
if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$pidFile = Join-Path $root "deepseek-backend.pid"
if (Test-Path -LiteralPath $pidFile) {
    $raw = ([IO.File]::ReadAllText($pidFile)).Trim()
    if ($raw -match "^\d+$") {
        $n = [int]$raw
        if ($n -gt 0) {
            try { Stop-Process -Id $n -Force } catch { }
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
}
Start-Sleep -Milliseconds 400
$killed = $false
try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    if ($c) {
        $pids = $c | ForEach-Object { $_.OwningProcess } | Select-Object -Unique
        foreach ($p in $pids) {
            if ($p -and $p -gt 0) { try { Stop-Process -Id $p -Force; $killed = $true } catch { } }
        }
    }
} catch {
    $null = $null
}
if (-not $killed) {
    $lines = netstat -ano 2>$null
    if ($lines) {
        foreach ($line in $lines) {
            if ($line -notmatch "LISTENING") { continue }
            if ($line -notmatch ":$Port\s") { continue }
            $tok = ($line -split "\s+") | Where-Object { $_ }
            if ($tok.Count -lt 1) { continue }
            $last = $tok[$tok.Count - 1]
            if ($last -match "^\d+$") {
                $num = [int]$last
                if ($num -gt 0) { try { Stop-Process -Id $num -Force } catch { } }
            }
        }
    }
}
