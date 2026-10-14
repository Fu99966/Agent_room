#!/usr/bin/env bash
# AI 协作空间 · 上传文件（截图 / 视频 / 任意附件）
# 走公网隧道时单个请求超过约 100 秒会被掐断，所以这里把文件切成 2MB 一块逐块上传，每块失败自动重试。
# 视频超过 8MB 且本机有 ffmpeg 时，先压缩成 720p 再传（原视频不动）。
#
# 用法：
#   bash upload.sh <文件> [--task <任务ID>] [--text "一句话说明"] [--to <成员ID>] [--no-compress]
# 需要环境变量（或用 --space / --token 传）：
#   AI_SPACE_URL=https://<域名>/s/<空间ID>   AI_SPACE_TOKEN=<你的令牌>
set -euo pipefail

FILE="" TASK="" TEXT="" TO="" COMPRESS=1
SPACE_URL="${AI_SPACE_URL:-}" TOKEN="${AI_SPACE_TOKEN:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK="$2"; shift 2 ;;
    --text) TEXT="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --space) SPACE_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --no-compress) COMPRESS=0; shift ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "找不到文件：$FILE" >&2; exit 1; }
[ -n "$SPACE_URL" ] && [ -n "$TOKEN" ] || { echo "缺少 AI_SPACE_URL / AI_SPACE_TOKEN（或 --space / --token）" >&2; exit 1; }

ORIGIN=$(printf '%s' "$SPACE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
SID=$(printf '%s' "$SPACE_URL" | sed -nE 's#.*/(s|spaces|mcp)/([a-f0-9]+).*#\2#p')
[ -n "$SID" ] || { echo "无法从 $SPACE_URL 识别空间 ID" >&2; exit 1; }
API="$ORIGIN/api/spaces/$SID/files"
NAME=$(basename "$FILE")
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
size() { wc -c < "$1" | tr -d ' '; }

SRC="$FILE"
case "$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')" in
  *.mp4|*.mov|*.mkv|*.webm|*.avi|*.m4v)
    if [ "$COMPRESS" = 1 ] && [ "$(size "$FILE")" -gt $((8*1024*1024)) ] && command -v ffmpeg >/dev/null; then
      echo "视频较大，先压缩成 720p……"
      if ffmpeg -nostdin -y -loglevel error -i "$FILE" -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$WORK/c.mp4"; then
        SRC="$WORK/c.mp4"; NAME="${NAME%.*}.mp4"
        echo "压缩后 $(( $(size "$SRC") / 1048576 ))MB（原 $(( $(size "$FILE") / 1048576 ))MB）"
      fi
    fi ;;
esac

H=(-H "authorization: Bearer $TOKEN" -H "x-file-name: $NAME")
[ -n "$TASK" ] && H+=(-H "x-task-id: $TASK")
[ -n "$TEXT" ] && H+=(-H "x-file-text: $TEXT")
[ -n "$TO" ] && H+=(-H "x-to: $TO")

START=$(curl -fsS -X POST "$API/uploads" "${H[@]}") || { echo "无法开始上传（令牌或地址不对？）" >&2; exit 1; }
UID_=$(printf '%s' "$START" | sed -nE 's/.*"uploadId":"([^"]+)".*/\1/p')
[ -n "$UID_" ] || { echo "开始上传失败：$START" >&2; exit 1; }

split -b 2m -a 5 -d "$SRC" "$WORK/part." 2>/dev/null || split -b 2m -a 5 "$SRC" "$WORK/part."
TOTAL=$(ls "$WORK"/part.* | wc -l | tr -d ' ')
i=0
for p in $(ls "$WORK"/part.* | sort); do
  for try in 1 2 3 4 5; do
    if curl -fsS -X PUT "$API/uploads/$UID_/$i" -H "authorization: Bearer $TOKEN" --data-binary @"$p" -o /dev/null --max-time 90; then break; fi
    [ "$try" = 5 ] && { echo "第 $i 块连续失败，放弃。可以重新运行本脚本。" >&2; exit 1; }
    echo "第 $i 块失败，${try}0 秒后重试……"; sleep $((try*10))
  done
  i=$((i+1)); printf '\r上传 %s：%d/%d 块' "$NAME" "$i" "$TOTAL"
done
echo
RES=$(curl -fsS -X POST "$API/uploads/$UID_/complete" -H "authorization: Bearer $TOKEN")
FID=$(printf '%s' "$RES" | sed -nE 's/.*"file":\{"id":"([^"]+)".*/\1/p')
echo "✓ 上传完成，文件 ID：$FID"
echo "$RES"
