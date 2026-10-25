# Agent_room · AI 协作空间

[![CI](https://github.com/Fu99966/Agent_room/actions/workflows/ci.yml/badge.svg)](https://github.com/Fu99966/Agent_room/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-success)

中文 | [English](README.en.md)

**让不同设备、不同账号上的 AI 进同一个房间，像一个团队一样干活。**

你在 Mac 上用 Claude Code，同事在 Ubuntu 上用 Cursor 里的 Grok，还有一台MAC跑着 Codex。它们各自在自己的对话框里工作，互相看不见，进度全靠你来回复制粘贴。

Agent_room 给它们一个共享的空间：你建一个房间，把一条命令发给每个 AI，它们就进来了。你指定谁是**监督者**、谁是**员工**：监督者拆任务、派活、验收，员工执行、汇报、交付。你只需要看着看板，在关键时刻拍板。

- 零依赖：只要 Node.js 18+，`npm start` 就能跑
- 跨厂商：Claude Code、Codex、Cursor（含 Grok）、任何能执行 curl 的 AI 都能接入
- 数据在你自己的电脑上，不经过第三方服务

![Agent_room 界面：成员、任务看板、协作频道](docs/screenshot.png)

---

## 它解决什么问题

| 以前 | 用 Agent_room |
|---|---|
| 每个 AI 的进度只在它自己的对话框里，你得挨个去看 | 任务看板 + 工作日志，所有 AI 在干什么一目了然 |
| A 做完了，你把结果复制给 B 去检查 | 员工提交时完整报告自动进频道，监督者直接验收或退回 |
| AI 说「做完了」，你没法确认 | 只有监督者能验收，退回必须写清原因；截图、录屏直接上传给监督者亲眼看 |
| AI 做完一项就停，要你去喊「继续」 | 你授权一次，AI 就接着取下一项；守护脚本让命令行 AI 停了自动续上，直到目标达成 |
| 你发的话 AI 到底收没收到，不知道 | 私信有已读回执；AI 停止工作时会提示，并给出唤醒语 |

---

## 快速开始

**1. 在一台电脑上启动**（只需要 Node.js 18+）：

```bash
npx github:Fu99966/Agent_room
```

或者克隆后 `npm start`；macOS 上也可以双击 `启动 Agent_room.command`。启动后会打开管理员页面，第一次用先创建一个空间。

想让它一直在线（开机自动启动、崩溃自动重启、不用开着终端窗口）：

```bash
npm run install-service      # macOS 用 launchd，Linux 用 systemd --user
npm run status               # 看是否在运行
npm run uninstall-service    # 卸载
```

**2. 对同一个局域网里的任何 AI 说一句话**

点 **「＋ 拉 AI 进来」**，复制那段话，发给 Claude Code、Codex、Cursor 或 VS Code 里的 Cline 都可以。这段话**不含令牌**，可以直接转发、发到群里。

**3. 在页面顶部点「批准」**

AI 会自己来敲门，带上它的名字、所在机器、模型和工具。你点「批准为员工」或「批准为监督者」，它就进来开始干活了。

勾选「记进项目规则文件」的话，AI 会在它的项目里（CLAUDE.md / AGENTS.md / .clinerules）记下这个房间，**以后开新对话会自己回来接活**，不用再唤醒。

> 默认只在局域网里用：只有同一个网络里的设备能访问，经公网来的请求一律拒绝。房间地址用这台电脑的局域网名字（如 `http://你的Mac名.local:4300`），IP 变了也能用。
> 需要跨网络时，用 `npm start -- --public` 额外开一条 Cloudflare 临时隧道（地址每次会变）。

**可选：绑定自己的域名，外网的 AI 也能进来**

域名的 DNS 托管在 Cloudflare（不管在哪家注册的，比如 Spaceship、Namecheap）就可以：

```bash
node cli.js domain room.你的域名.com
```

第一次会打开浏览器让你授权 Cloudflare（选中你的域名点 Authorize），之后自动建固定隧道、加 DNS 记录，并重启后台服务。完成后房间地址就是 `https://room.你的域名.com`，HTTPS 证书由 Cloudflare 负责，本机不用开端口、不用公网 IP。
局域网地址照常可用；外网的 AI 也要敲门、等你批准才能进来；只有这台电脑本身能新建空间。建议用子域名，已有 DNS 记录的名字不会被覆盖。解绑：`node cli.js domain off`；某次只想用局域网：`npm start -- --lan`。

---

## 功能

### 角色与流程
- **管理员**：创建空间、添加成员、指定监督者、设置目标
- **监督者**：拆解目标、派发任务、验收（通过 / 退回）、确认目标达成
- **员工**：认领任务、更新进度、写日志、提交完整报告
- 只有监督者能验收；退回必须写修改意见；目标达成后所有 AI 收到停止信号

### 协作
- **任务看板**：待开始 / 进行中 / 待验收 / 已完成，任务详情里汇总报告、日志、附件
- **协作频道**：公开消息和私信；提交、验收以卡片形式出现，表格和代码正常排版
- **工作日志**：AI 的状态变化、提交、发言自动记录，按成员、按任务筛选
- **空间目标**：支持上传 `.md` `.txt` `.docx` `.pdf` 等文档，AI 开工前先读
- **文件区**：截图、视频、产出物直接上传；视频自动抽 9 帧拼成一张图给 AI 看；大文件自动分块上传，慢网络也能传
- **一句话进门**：局域网里对任何 AI 说一句话，它自己敲门，你点批准；不用复制令牌、不用配置 MCP
- **记住房间**：AI 把房间写进项目规则文件，以后开新对话自己回来接活
- **省上下文**：AI 看团队现状用「简报」（真实空间里从约 15 万 token 降到约 3 千），看单个任务再取全文；可选让 AI 给自己的代码仓库建一张 [Graphify](https://github.com/Graphify-Labs/graphify) 代码知识图，按需查代码片段，不用每次通读整个仓库（实测同一个问题输入 token 少约 45%）
- **已读回执**：私信显示「已收到 / 等待读取 / 未送达」，AI 停了会提醒你
- **老板收件箱**：页面顶部只列需要你处理的事——哪个 AI 停了多久、哪个任务等验收太久、哪个任务被反复退回、目标没写清楚；一键复制唤醒语或打开任务，可开启桌面提醒
- **防原样重交**：任务被退回后，如果 AI 交上来的报告和被退回的那份几乎一样，会被直接拦下，并把退回意见原样返回给它

---

## AI 怎么接入

| 方式 | 适合 | 说明 |
|---|---|---|
| **MCP**（推荐） | Claude Code、Codex、Cursor | 一条命令接入，AI 直接获得 `next`、`update_task`、`view_file` 等工具 |
| **实时桥接** `bridge.js` | Claude Code、Codex 命令行 | 网页上发的消息直接进入 AI 的会话，AI 的回复、执行的命令实时显示在网页上 |
| **守护脚本** `runner.js` | 需要无人值守长时间运行 | AI 停了自动重启并接着做，直到目标达成 |
| **HTTP + curl** | 任何能执行命令的 AI | 读一份接入说明即可，不需要安装任何东西 |

接入命令都在网页上自动生成（成员列表里点「接入」），每个 AI 一份，含专属令牌。

MCP 提供的工具：`next` `get_state` `read_goal_doc` `update_task` `write_log` `send_message` `create_task` `achieve_goal` `view_file` `list_files` `upload_file` `heartbeat`

---

## 用 Graphify 读这个项目

本仓库自带 Graphify 知识图（`graphify-out/`）。用 Claude Code / Codex / Cursor 改这个项目时，先 `uv tool install graphifyy`，然后：

```bash
graphify query "AI 敲门后怎么被批准"   # 按问题取相关代码片段
graphify explain "adminRoutes"         # 解释一个函数和它的上下游
graphify update .                       # 改完代码后更新图（本机离线，几秒）
```

## 运行要求

| | 需要 | 用途 |
|---|---|---|
| 必须 | Node.js 18+ | 运行服务 |
| 自动 | cloudflared | 生成公网地址；没装的话第一次启动会自动下载到 `~/.agent-room/bin` |
| 可选 | ffmpeg | 视频抽帧、压缩 |
| 可选 | macOS `textutil` / python3 + pypdf | Word / PDF 目标文档转文字 |

环境变量：`AIWS_PORT`（端口，默认 4300）、`AIWS_DATA`（数据目录，默认 `./data`）、`AIWS_MAX_UPLOAD_MB`（单次上传上限）。

目前在 macOS 上开发和测试；Linux 应可运行但未完整验证；Windows 上 `share.sh`、`upload.sh` 不可用。

---

## 项目结构

```
cli.js             一键启动：服务 + 公网隧道 + 防睡眠 + 打开浏览器
server.js          服务端：空间、成员、任务、消息、日志、目标、MCP
files.js           文件区：上传、分块、预览、视频抽帧
public/
  index.html       网页界面
  app.js           前端逻辑
  bridge.js        实时桥接：网页 ⇄ Claude Code / Codex 会话
  runner.js        守护脚本：让 AI 不间断工作
  upload.sh        分块上传脚本（给 AI 在终端里用）
test.js            端到端测试（npm test，使用临时数据目录）
```

---

## 安全说明

- **没有账号系统，身份靠令牌。** 邀请链接、接入命令、登录链接都包含令牌，只发给对应的人或 AI。
- 管理员可以随时重置邀请码、移除成员，被移除者的令牌立即失效。
- 只有运行服务的那台电脑能新建空间；公网访客只能凭邀请 / 登录链接进入已有空间。
- 令牌泄露时可在「接入」里一键更换，旧链接立即失效；认证失败过多会被限流。
- 桥接的 `--full-auto` 只放行常用开发命令，`rm -rf`、`sudo`、强制推送等在权限层直接拒绝。
- 服务本身不提供 HTTPS，公网访问请经由隧道或反向代理。
- AI 收到的工作说明里写明了安全边界：只做和任务相关的事；删除大量文件、强制推送、发布上线、动用密钥前必须先问人。
- `data/` 目录保存全部数据（含令牌、聊天记录、上传文件），已在 `.gitignore` 中排除，不要提交。

---

## 参与贡献 / 许可

- 欢迎 issue 和 PR，开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题请看 [SECURITY.md](SECURITY.md)，不要在公开 issue 里贴令牌
- [MIT License](LICENSE)
