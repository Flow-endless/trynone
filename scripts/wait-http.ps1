# 轮询直到本机端口可访问（与 Electron / Spring 对 / 或 /index.html 的响应一致）
param(
    [int]$Port = 8081,
    [int]$Seconds = 120
)
$uris = @(
    "http://127.0.0.1:$Port/index.html",
    "http://127.0.0.1:$Port/"
)
for ($i = 0; $i -lt $Seconds; $i++) {
    foreach ($uri in $uris) {
        try {
            $r = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 }
        }
        catch { }
    }
    Start-Sleep -Seconds 1
}
exit 1
