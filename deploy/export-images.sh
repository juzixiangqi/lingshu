#!/usr/bin/env bash
# 生成私有化离线安装包（Linux / macOS 构建机）
# 用法：bash deploy/export-images.sh [输出目录，默认 deploy/dist]

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$DEPLOY_DIR")"
OUT_DIR="${1:-$DEPLOY_DIR/dist}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

echo "[export] 构建镜像"
docker compose -f "$COMPOSE_FILE" build

mkdir -p "$OUT_DIR"
TAR_PATH="$OUT_DIR/lingshu-images.tar"

echo "[export] 导出镜像到 $TAR_PATH"
docker save -o "$TAR_PATH" \
  lingshu-api:latest \
  lingshu-collab:latest \
  lingshu-web:latest \
  postgres:16-alpine \
  redis:7-alpine

cp "$COMPOSE_FILE" "$OUT_DIR/docker-compose.yml"
cp "$DEPLOY_DIR/.env.example" "$OUT_DIR/.env.example"
cp "$REPO_ROOT/docs/deployment.md" "$OUT_DIR/DEPLOY.md"

echo "[export] 完成：$OUT_DIR"
ls -lh "$OUT_DIR"
