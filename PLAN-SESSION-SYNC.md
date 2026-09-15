# 会话同步 —— 最终方案

> 状态：**已实现**（4 项调研全部完成，关键结论均有 `file:line` 证据）。
> 实现落在 `src/host/sessions.js`（导出/导入引擎）、`src/host/notice.js`（设备切换提示）、
> `src/host/index.js` + `src/host/git.js`（挂进同步时序）、`src/client/index.js`（开关）。
> 本文只写核实过的事实；未核实或明确不保证的部分单独标注。

## 0. 一句话方案

**导出**：用 `ctx.sessionPersistence` 读日志 → 转成**规范 JSONL**（首行物理 header + 每行一个逻辑事件）
→ 压缩后写进**工作区域目录内的 `.dsh-sessions/<sessionId>.jsonl.zstd`** → 复用现有 git 引擎同步。

**导入**：扫描工作区域内的 `.dsh-sessions/` → 对本地不存在的会话走官方写入路径
`sessionPersistence.create(header)` → `handle.append(events)` → `flush()` → `close()`。

**提示词**：导入过的会话在 `agent/created` 时通过**作用域内的 `systemPrompt.section()`** 注入一段
用户不可见的提示，告知模型「历史来自另一台设备」。

全程**不新增任何 npm 依赖**，只消费 DSH 已有的服务。

## 1. 需求（用户明确）

1. 会话同步是 **dsh-sync-tool 插件的一项功能**，代码在本仓库，不新开仓库。
2. 用**结构化数据**的形式同步（不是把二进制日志整块搬）。
3. **范围 = 选定工作区域内的会话**，按会话 header 的 `cwd` 判定。
4. 第二台机器上同一会话**保持身份**、**命中缓存**、不产生「重新开局」的额外费用。
5. 导入后会话**一切功能正常**（可列举、可打开、可续聊）。
6. 通过**会话启动时的提示词注入**，以**用户不可见**的方式让模型知道「换了设备」。

## 2. 核实的事实（含证据）

### 2.1 官方导出/导入能力的边界

| 问题 | 结论 | 证据 |
|---|---|---|
| 存在会话导出 | **是**，但产物是「浏览器下载的 ZIP」 | `packages/session-query/session-log-export/src/index.ts:38-42,78-99` |
| 导出格式 | 规范 JSONL（header 行 + 每行一个逻辑事件），**无 manifest** | `session-log-export/src/archive.ts:1-22,110-136` |
| 存在导入 | **否**（无 CLI、无命令、无端口、无代码路径） | 包内 grep 只命中 ESM import 与测试 `unzipSync`；`README.md:124,137` |
| 导出通过 Cordis 服务暴露 | **否**（"No companion is published"） | `session-log-export/README.md:141` |

⇒ 导出形态**直接采用官方形态**（规范 JSONL），但**不走官方 ZIP**：ZIP 里还有附件字节，
且 `media/`、`files/`、`subagents/` 布局与后端磁盘布局不同，解开丢回机器不会被识别。
本插件只同步**会话记录本身**，不含附件字节。

### 2.2 导入必须走官方写入路径

`session-persistence/src/index.ts` 与 `handle.ts`（逐字签名）：

```
create(header, options?)  -> SessionHandle     // index.ts:147
open(id, 'read'|'write')  -> SessionHandle     // index.ts:162
stat(id)                  -> Snapshot | undefined   // index.ts:191
list()                    -> readonly Snapshot[]    // index.ts:198
handle.read(offset?, length?) -> { eventState, events }   // handle.ts:83
handle.append(events)     -> void             // handle.ts:97
handle.flush() / close()                      // handle.ts:109,116
```

`sessionPersistence` README 的决定性一句：

> **Only handle-acquired sessions persist** — `ctx.sessions.create` + `session/flush` alone stores
> nothing; agent-loop is the production acquisition point, and **tests seed storage through
> `create`/`append`/`close`**.

⇒ 导入**不需要**自己实现 zstd 分帧、generation 文件名、编码选择：后端按本机配置写出原生日志。
这正是本方案「优雅」的核心。

### 2.3 header 与事件的形状

- 逻辑 `SessionHeader`（`core/session/src/types.ts:93-130`）：
  `{ version, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset? }`
  —— **没有 `type`**。
- 物理 header 行在此之上加 `type:'session'`，且**键白名单严格**
  （`session-persistence-jsonl/src/format.ts:95-97,158-184`）：
  必需 `type/version/id/createdAt/isSeeded/delegationDepth`，可选 `cwd/parentSession/origin/agentPreset`。
- `create()` 只做 JSON 可序列化 + `createdAt` 非负校验（`storage-contract.ts:112-121`），
  **不拒绝额外键**，但我们仍然剥掉 `type` 再传。

⇒ 归档首行直接用物理 header 行，导入时剥掉 `type` 交给 `create()`。

### 2.4 seeded（fork 出来的）会话

- `session/end-seed` 事件的 `data.inherited === true` 标记继承切点，
  其 `seq` 就是 `inheritedEventCount`（`core/session/src/index.ts:606-608`）。
- `create(header, { inheritedEventCount })` 对 seeded header 是**必需**的
  （`session-persistence-jsonl/src/format.ts:118-128`）。

⇒ 导入 seeded 会话时从事件里反推切点；推不出来就跳过并报错，不猜。

### 2.5 缓存（必须如实说明）

`session-persistence` README：

> **Persistence does not mutate live request prefixes.** A resumed loop can reuse provider cache
> only when its **reconstructed history, current envelope, and model route** match.

⇒ 同一 id + 同一事件序列是**必要**条件（本方案保证：事件是官方 API 读出来的逻辑事件，
`append` 后重建出的历史逐一相同）。envelope（系统提示、`cwd`、工具表）一致才是**充分**条件。
两台机器工作区域**绝对路径相同**时两者同时成立；路径不同则 **cwd 一改 envelope 就变**。

⇒ 方案给 `cwdPolicy` 三档，默认 `auto`（本机存在就用原路径，否则改写为本机区域路径），
并在状态里**明确显示是否改写过**，README 里写清「想稳中缓存就让两台机器用同一个绝对路径」。

### 2.6 存储布局的硬约束（为什么归档不放进 `sessions/`）

- `listProjectDirs` 把 sessions 根下**每一个目录**都当作项目目录（不按 `--…--` 前缀过滤）
  ⇒ 在 `sessions/` 里 `git init` 会让 `sessions/.git/` 变成一个"项目"。
- 同一 root 内编码必须统一：`.jsonl` 与 `.jsonl.zstd` 混存会被 `encodingMismatch` 拒绝
  （`session-persistence-jsonl/src/index.ts:1369-1394,1528-1541,1585-1591`），**连 `list()` 都抛**。
- 读取端从不碰 lease（`lease.ts:19`），复制过来的 `session.lock` 不会阻止加载。

⇒ 归档放进**用户的工作区域目录**，一举两得：既满足「范围=工作区」，又天然复用现有 git 引擎。
导入由后端按**本机配置的 compression** 重新编码 ⇒ 不依赖目标机器的编码与格式代际
（v0→v3 迁移链是闭合的，`session-format-catalog/src/generated.ts:13-18`）。

### 2.7 提示词注入点（R4）—— 最终选择 `systemPrompt.context()`

调研结论（逐字证据）：

- `systemPrompt.section()` / `context()` 都是**按作用域**注册的（`system-prompt/src/index.ts:440-457,483-492`），
  且 `text` 可以是 `(context) => string`，其中 `AssembleContext.agent` 由 `dsh-agent` augment
  （`core/agent/src/runtime-types.ts:17-23`，loop 每步用 `assembleContextFor(agent, signal)` 传入，
  `core/agent/src/dispatch.ts:174-176`）。返回 `''` 的段在渲染时被丢弃
  （section: `index.ts:273-278`；context: `index.ts:310-316`）。
- **不可见性的真相**：`system/message` 在 Chat 里是一个**默认折叠、可点击展开**的 disclosure 行
  （`client/ui-chat/src/client/chat/SystemPromptRow.tsx:25-43`），Trajectory 另有 System Prompt tab；
  `agent.inject()` / pre-step 注入的 user-role 消息则是**直接可见的 context 行**。
  仓库内没有任何「真正不可见」的通道。

**两条路线的取舍（决定性）= 缓存**：

| 路线 | 落点 | 代价 |
|---|---|---|
| `systemPrompt.section()` | surface **node 0** | resume 的第一步 `startsSeries=true`，`SystemPromptProjection.project` 走 replace 分支（`agent-loop/src/runtime-context.ts:88-93`）⇒ **从 token 0 起整段前缀缓存失效** |
| `systemPrompt.context()` | **动态运行上下文快照**，由 loop 作为 durable `user/message` **追加在历史之后**（`runtime-context.ts:145-156`、`agent.ts:249-255,373-377`） | 只多一次很小的 cache write，**已缓存前缀逐字节不变** |

⇒ 采用 **`ctx.systemPrompt.context()` + 一个全局注册、在 provider 内按 `context.agent.session.header.id` 条件化** 的实现。
它同时满足「模型可见」「用户侧不新增界面元素（并入每个会话本来就有的『当前运行上下文』快照行）」
与「不破坏前缀缓存」。已实现在 `src/host/notice.js`。

### 2.8 `cwd` 绝不改写（缓存的决定性因素）

shipped preset 的 persona 是 `Your working directory is {{cwd}}.`
（`preset/agent-presets/presets/standard/agent.cordis.yml:22-27`），变量来自
`agent.session.header.cwd`（`core/agent-loop/src/index.ts:421-423`）。
⇒ **改 `cwd` = 换掉 system 头节点 = 从 token 0 全量失效**。
而且冷会话续聊**不要求 cwd 目录存在**（`agent-loop/src/index.ts:876-899` 全程无 `stat(cwd)`），
cwd 不存在只影响（a）工作区分组落到「未分组」、（b）文件/命令类工具执行。

⇒ `cwdPolicy` 默认 **`keep`**；`auto`/`area` 是显式选项，会在状态里报告「已改写」。

### 2.9 会话归属：区域内 ∪ 本区域导入过的

B 机上导入的会话，其 `header.cwd` 仍是 A 机的路径。若导出只按 cwd 判定范围，
B 机的续聊**永远发布不回去**。因此导出范围 = `cwd ∈ 区域` **或**「该会话由本区域导入」
（机器本地 `imported[id].areaId`）。已实现在 `exportArea`。

## 3. 归档格式（对外契约）

工作区域内：

```
<area>/.dsh-sessions/<sessionId>.jsonl.zstd      # 默认；compression=none 时是 .jsonl
```

内容是**规范 JSONL**（UTF-8，LF）：

```
{"type":"session","version":3,"id":"…","createdAt":…,"cwd":"…","parentSession":"…","isSeeded":false,"origin":"…","delegationDepth":0,"agentPreset":"…"}
{"type":"user/message","seq":9,"time":…,"data":{…},"surfaceOp":"append"}
{"type":"tool/call","seq":10,"time":…,"data":{…}}
…
```

- 第 0 行是物理 header 行（键序与 DSH 物理编码一致，可选字段缺省即省略）。
- 之后每行一个**逻辑事件**（`data` 是对象，不是物理形态里被字符串化的 `data`）。
- 稳定顺序（按 seq）、稳定键序 ⇒ `compression: none` 时是一份**可 diff、可 review** 的文本。

压缩用 `node:zlib` 的 `zstdCompressSync` / `zstdDecompressSync`（DSH 自身也依赖这个能力）。

**机器本地状态**（不进仓库）保存在 `$DSH_HOME/sync-tool/sessions.json`：
导出侧记录「上次导出的文件指纹」，导入侧记录「本会话是从哪台机器导入的」——后者就是提示词的依据。

## 4. 同步时序（嵌进现有 git 引擎）

现有单次区域同步：`识别仓库 → 对齐 origin → 提交 → fetch → 快进/rebase → push`。

插入两个钩子：

```
… → 对齐 origin
    → [导出会话]              写 .dsh-sessions/  ← 必须在提交之前
    → 提交
    → fetch / 快进或 rebase
    → [导入会话]              读 .dsh-sessions/  ← 必须在合并之后
    → push
```

导出/导入整体失败**不会**影响 git 主流程，只把信息写进状态与历史。

### 4.1 导出算法

1. `sessionPersistence.list()` 拿全部快照（含 `header.cwd`、`revision`、`sizeBytes`，**不读日志**）。
2. 过滤 `cwd ∈ 该工作区域` **或**「该会话由本区域导入」（见 2.9）。
3. 超过 `maxSessions` 时只取 `createdAt` 最新的 N 条，其余计入 `skipped`。
4. 本地状态里该会话的 `revision` 与归档文件（size+mtime）都没变 ⇒ **跳过**（零读盘）。
5. 否则 `open(id,'read')` → `read(0)` → `serializeSession(header, events)` → 压缩 → 原子写
   （写 `.tmp` 再 `rename`，避免同步中途被读到半个文件）。
6. 归档不是本机写的：解析后比较，本地日志**已包含**归档（`local-ahead`/`equal`）才允许覆盖；
   `remote-ahead`/`diverged` ⇒ **不覆盖**，留给导入处理。

### 4.2 导入算法

1. 扫描该工作区域的 `.dsh-sessions/`。
2. 文件名后缀与配置的 `compression` 不一致 ⇒ 跳过并记一条说明（不猜、不混写）。
3. `sessionPersistence.stat(id)` 为 absent ⇒ `create(header[, {inheritedEventCount}])`
   → `append(events)`（分批，每批 ≤ 200 条）→ `flush()` → `close()` → 记进 `imported`。
4. 已存在：
   - 两边都没变（归档指纹 + 本地 revision）⇒ 零读盘跳过；上次判定为分叉则继续报 `conflict`。
   - `equal` / `local-ahead` ⇒ 本地领先，不动。
   - `remote-ahead` ⇒ `open(id,'write')` → 只 `append` 尾部。
   - `diverged`（真分叉）⇒ **不动本地**，把两个分支分别另存为
     `.dsh-sessions/conflicts/<id>.<归档mtime>.remote.jsonl` 与
     `<id>.<归档mtime>.<host>.local.jsonl`（名字稳定 ⇒ 重跑不重复产生文件），状态里报 `conflict`。
5. 导入的每个会话写进机器本地 `imported`，供提示词与「归属」使用。
6. 导入后把归档登记为「本机已发布」，否则导出侧会永远认为它是别台机器的未发布物。

## 5. 配置与界面

新增 `Config.sessions`（默认开启，可关）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否同步会话记录 |
| `dir` | `.dsh-sessions` | 工作区域内的归档子目录 |
| `compression` | `zstd` | `zstd` 紧凑 / `none` 可 diff |
| `includeDescendants` | `true` | 是否包含 cwd 在工作区域**子目录**里的会话 |
| `maxSessions` | `200` | 每个区域最多同步多少条会话 |
| `maxBytes` | `0` | 单条上限（0 = 不限） |
| `cwdPolicy` | `keep` | `keep`（默认，保缓存）/ `auto` / `area`，见 2.8 |
| `hintOnDeviceSwitch` | `true` | 是否给模型注入「换了设备」提示 |
| `statePath` | `''` | 机器本地状态文件；空 = `$DSH_HOME/sync-tool/sessions.json` |

界面：状态卡的 `detail` 里附上 `会话↑N`、`会话↓M`、`会话并入M`、`会话冲突K`、`会话失败K`；
卡片新增一个「同步会话记录」复选框。

## 6. 测试与验收（全部已完成并跑通）

| 层次 | 内容 | 结果 |
|---|---|---|
| 单元 | 规范 JSONL 序列化↔解析往返；header 键白名单；可选字段缺省；seeded 切点 | ✅ |
| 单元 | 比较器：equal / local-ahead / remote-ahead / diverged | ✅ |
| 集成（假后端） | 导出→导入：跳过、上限、分叉、编码不匹配、cwdPolicy 三档、导入归属 | ✅ |
| 集成（真后端） | `@deepseek-ai/dsh-session-persistence-jsonl` 造会话→导出→导入另一 root→逐事件比对 | ✅ `scripts/e2e-sessions.mjs` |
| 规范文本保真 | 导出的规范文本与真后端 `compression: none` 写出的文件**逐行相同**（0 行差异） | ✅ |
| 提示词 | 只对导入过的会话贡献；内容正确；关闭开关后为空 | ✅ |
| 双平台 | Windows 全量 72 项；Linux（WSL）全量 | ✅ |

**明确不承诺**：两台机器工作区域绝对路径不同且选择改写 `cwd` 时的前缀缓存全中（envelope 变了）。
**明确不含**：附件/图片字节（只同步会话记录本身）。

## 7. 与旧方案的差异

- 归档**不写进 `sessions/`**，写进工作区域（避免 2.6 的两个硬约束）。
- 导入**不复用官方 ZIP 导出**（它带附件布局且无导入端），改用官方**持久化写入 API**。
- 归档**不是逐字节副本**，而是官方口径的规范 JSONL ⇒ 与机器编码、格式代际解耦。
- 提示词注入点确定为 **agent 作用域内的 `systemPrompt.section()` + `agent/created`**。
