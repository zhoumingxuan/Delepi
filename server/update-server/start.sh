#!/usr/bin/env bash
# 用途：在 Linux / macOS 上一键启动 Delepi 自动更新服务端。
# 使用前请先安装依赖：python3 -m pip install -r requirements.txt
#
# 监听地址与端口可以用环境变量覆盖（默认只监听本机回环，由 Nginx 反向代理对外提供 HTTPS）：
#   DELEPI_UPDATE_HOST  默认 127.0.0.1
#   DELEPI_UPDATE_PORT  默认 8080
# 例：DELEPI_UPDATE_HOST=0.0.0.0 DELEPI_UPDATE_PORT=9000 bash start.sh
set -euo pipefail

# 切到脚本所在目录，保证 ./data 与 ./packages 的相对路径解析正确
cd "$(dirname "$0")"

HOST="${DELEPI_UPDATE_HOST:-127.0.0.1}"
PORT="${DELEPI_UPDATE_PORT:-8080}"

# 生产环境建议保持默认的 127.0.0.1，由 Nginx 反向代理对外；
# 如需直接对外，显式设置 DELEPI_UPDATE_HOST=0.0.0.0（务必同时配置防火墙与 TLS）。
exec uvicorn app:app --host "$HOST" --port "$PORT"
