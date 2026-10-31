# 生成私有化离线安装包：构建镜像 -> 导出成单个 tar -> 连同 compose 与说明一起打包
#
# 用法（在仓库根目录执行）：
#   powershell -ExecutionPolicy Bypass -File deploy/export-images.ps1
#   可选参数：-OutDir deploy/dist

param(
  [string]$OutDir = "deploy/dist"
)

$ErrorActionPreference = "Stop"
$deployDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $deployDir
$composeFile = Join-Path $deployDir "docker-compose.yml"

Write-Host "[export] 构建镜像（首次会拉取 node/nginx/postgres/redis 基础镜像）"
docker compose -f $composeFile build
if ($LASTEXITCODE -ne 0) { throw "镜像构建失败" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outPath = (Resolve-Path $OutDir).Path
$tarPath = Join-Path $outPath "lingshu-images.tar"

Write-Host "[export] 导出镜像到 $tarPath"
$images = @(
  "lingshu-api:latest",
  "lingshu-collab:latest",
  "lingshu-web:latest",
  "postgres:16-alpine",
  "redis:7-alpine"
)
docker save -o $tarPath $images
if ($LASTEXITCODE -ne 0) { throw "镜像导出失败" }

Copy-Item $composeFile (Join-Path $outPath "docker-compose.yml") -Force
Copy-Item (Join-Path $deployDir ".env.example") (Join-Path $outPath ".env.example") -Force
Copy-Item (Join-Path $repoRoot "docs/deployment.md") (Join-Path $outPath "DEPLOY.md") -Force

Write-Host "[export] 完成：$outPath"
Get-ChildItem $outPath | Select-Object Name, Length
