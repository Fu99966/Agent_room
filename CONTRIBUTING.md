# 参与贡献

欢迎提 issue 和 PR。

## 开发

```bash
git clone https://github.com/Fu99966/Agent_room.git
cd Agent_room
npm start          # 启动服务 + 公网隧道；只在本机调试用 npm run start:local
npm test           # 端到端测试，使用临时数据目录，不会碰你的 data/
```

零依赖是这个项目的原则：请不要引入 npm 依赖。需要外部工具（ffmpeg、cloudflared 等）时，做成可选功能，缺失时要能降级运行。

## 提交 PR 前

- `npm test` 全部通过（CI 会在 Ubuntu / macOS、Node 18 / 22 上跑）
- 新功能补上对应的测试（`test.js`）
- 改了给 AI 看的说明文字（接入说明、`next` 的 instruction），请用真实的 Claude Code / Codex 跑一遍，确认 AI 会照做、不会拒绝
- 不要提交 `data/`、日志或任何令牌
