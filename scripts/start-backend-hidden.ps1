# 无窗口启动 Spring Boot JAR（供 start-all.bat 调用）
param(
    [Parameter(Mandatory = $true)][string]$JarPath,
    [string]$WorkingDirectory = ""
)
if (-not (Test-Path -LiteralPath $JarPath)) {
    Write-Error "JAR not found: $JarPath"
    exit 1
}
if (-not $WorkingDirectory) {
    $WorkingDirectory = Split-Path -Parent $JarPath
}
$proc = Start-Process -FilePath 'java' -ArgumentList @('-jar', $JarPath) -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
# 供 Electron（SKIP_EMBEDDED_JAVA=1）退出时结束本次由 start-all 拉起的 Java，避免 8081 残留占用
$targetDir = Split-Path -Parent $JarPath
$projectRoot = Split-Path -Parent $targetDir
$pidFile = Join-Path $projectRoot 'deepseek-backend.pid'
try {
    $proc.Id.ToString() | Out-File -LiteralPath $pidFile -Encoding ascii -NoNewline
} catch {
    Write-Warning "Could not write $pidFile : $_"
}
exit 0
