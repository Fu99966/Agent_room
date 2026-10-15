#!/bin/bash
# 兼容旧用法：现在一条命令就够了，等同于 npm start
exec node "$(dirname "$0")/cli.js" "$@"
