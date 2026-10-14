#!/bin/bash
# 启动服务并通过 Cloudflare 临时隧道生成公网链接，其他设备/账号的 AI 用这个链接接入
cd "$(dirname "$0")"
PORT=${AIWS_PORT:-4300}
lsof -ti tcp:$PORT >/dev/null || (AIWS_PORT=$PORT node server.js > server.log 2>&1 &)
sleep 1
echo "本机地址：http://localhost:$PORT"
echo "正在生成公网链接（出现 https://xxx.trycloudflare.com 即可分享）..."
cloudflared tunnel --url http://localhost:$PORT 2>&1 | grep --line-buffered -o 'https://[a-z0-9-]*\.trycloudflare\.com'
