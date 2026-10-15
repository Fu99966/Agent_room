#!/bin/bash
# macOS：在访达里双击这个文件即可启动（第一次可能要右键 → 打开）
cd "$(dirname "$0")" && exec node cli.js "$@"
