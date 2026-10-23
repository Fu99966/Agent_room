# Graph Report - ai-workspace  (2026-10-23)

## Corpus Check
- 17 files · ~39,230 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 318 nodes · 575 edges · 14 communities (12 shown, 2 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `74a3be34`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.js
- app.js
- bridge.js
- cli.js
- package.json
- Agent_room · AI 协作空间
- files.js
- runner.js
- lobby.js
- test.js
- upload.sh
- share.sh

## God Nodes (most connected - your core abstractions)
1. `api()` - 37 edges
2. `enter()` - 17 edges
3. `esc()` - 16 edges
4. `toast()` - 12 edges
5. `now()` - 12 edges
6. `openDetail()` - 11 edges
7. `renderMsgs()` - 11 edges
8. `renderAll()` - 10 edges
9. `Agent_room · AI 协作空间` - 9 edges
10. `log()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `adminRoutes()` --indirect_call--> `publicMember()`  [INFERRED]
  lobby.js → server.js
- `codexDriver()` --indirect_call--> `text()`  [INFERRED]
  public/bridge.js → server.js
- `isLocal()` --indirect_call--> `req()`  [INFERRED]
  server.js → test.js
- `saveState()` --indirect_call--> `token()`  [INFERRED]
  public/bridge.js → server.js

## Import Cycles
- None detected.

## Communities (14 total, 2 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.06
Nodes (66): addMessage(), api(), auth(), authFails, autoLog(), baseUrl(), beaconUrl(), broadcast() (+58 more)

### Community 1 - "app.js"
Cohesion: 0.11
Nodes (53): ago(), applyState(), badge(), call(), canReview(), copyBox(), enter(), esc() (+45 more)

### Community 2 - "bridge.js"
Cohesion: 0.08
Nodes (30): api(), args, claudeDriver(), codexDriver(), crypto, cwd, DENY, DEV_ALLOW (+22 more)

### Community 3 - "cli.js"
Cohesion: 0.11
Nodes (33): adminLink(), argv, banner(), BEACON_FILE, child(), DATA, ensureServer(), flag() (+25 more)

### Community 4 - "package.json"
Cohesion: 0.07
Nodes (29): bin, agent-room, description, engines, node, homepage, keywords, license (+21 more)

### Community 5 - "Agent_room · AI 协作空间"
Cohesion: 0.07
Nodes (25): 参与贡献, 开发, 提交 PR 前, Agent_room · AI 协作空间, AI 怎么接入, Agent_room · a shared room for your AI agents, Contributing / License, Features (+17 more)

### Community 6 - "files.js"
Cohesion: 0.14
Nodes (18): crypto, describe(), { execFile }, FFMPEG, FFPROBE, fs, handle(), imagesFor() (+10 more)

### Community 7 - "runner.js"
Cohesion: 0.17
Nodes (12): agentCommand(), api(), args, cwd, fs, log(), maxRuns, path (+4 more)

### Community 8 - "lobby.js"
Cohesion: 0.30
Nodes (13): adminRoutes(), agentCard(), crypto, findReturning(), handle(), lanAddrs(), lobbySpace(), lobbyText() (+5 more)

### Community 9 - "test.js"
Cohesion: 0.33
Nodes (5): assert, DATA, fs, path, { spawn }

## Knowledge Gaps
- **125 isolated node(s):** `fs`, `path`, `os`, `net`, `{ spawn, execFileSync }` (+120 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `text()` connect `server.js` to `bridge.js`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `codexDriver()` connect `bridge.js` to `server.js`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `api()` connect `server.js` to `bridge.js`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **What connects `fs`, `path`, `os` to the rest of the system?**
  _125 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06479113384484228 - nodes in this community are weakly interconnected._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1063973063973064 - nodes in this community are weakly interconnected._
- **Should `bridge.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08250355618776671 - nodes in this community are weakly interconnected._