# dsh-sync-tool 方案设计

> 目标：一个**真实安装的 DSH 插件**（非对话式动态 Cordis 插件），用户选择要同步的「工作区域」，
> 插件在**每轮对话结束后**自动把工作区域同步到用户自己的远程云端 git 仓库，
> 从而在不同电脑之间搬运 / 同步 DeepSeek Harness 的插件、预设、技能等资产。

本文所有机制均已在本机已安装的 DSH 上核实（见「已核实的机制证据」），不是猜测。

---

## 1. 需求拆解与硬约束

| # | 需求 | 设计响应 |
|---|---|---|
| R1 | 不是对话模式的插件 | 做成可安装 **bundle 包**，模型侧不注册任何工具，不出现在工具列表与对话流 |
| R2 | 基于远程 git 仓库 | 宿主侧 git 引擎（fetch/rebase/commit/push），用户自建远端 |
| R3 | 用户选择同步的工作区域 | 设置页 + 原生目录选择器（`ctx.directoryPicker`） |
| R4 | 每轮对话自动同步 | `ctx.on('session/event')` 中 `turn/end` 触发，防抖 + 单飞队列 |
| R5 | 可跨电脑同步 | 双向同步 + 仓库内便携清单 `.dsh-sync.yml`，另一台机器 clone 后一键导入 |

**明确的非目标**：不注册模型工具；不改 agent-loop；不同步 `node_modules`、会话记录、凭据文件；
不做自动冲突合并（冲突必须停下来交给人）。

---

## 2. 已核实的机制证据

这些是方案的立足点，全部来自本机环境：

**2.1 安装模型 = bundle 包 + profile**
- 本机 profile：`$DSH_HOME/profiles/<profile>`
  - `package.json`：`dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`，且 `patchReload: "live"`
  - `cordis.patch.yml`：用户自己的补丁层（当前为 `[]`）
  - `cordis.yml`：空根，注释明确写「Edit cordis.patch.yml, not this file」
- 安装方式：`dsh plugin --profile web add <包路径>` —— 转发给 profile 目录内的 pnpm，
  若包声明了 `dsh.bundle` 就自动追加进 `dsh.profile.bundles`
  （依据 `docs/user/develop/basic/publish.md`，本机 `dsh --version` = 0.1.5-rc.1）
- 本机 GUI 正以源码方式运行：`node --import tsx/esm apps/cli/src/bin.ts web`

**2.2 浏览器半边（client half）契约** —— 直接读已安装包核对：
```
exports["."]        -> lib/index.js     (宿主半边)
exports["./client"] -> lib/client.js    (浏览器半边，必须预构建)
dsh.client = { platform: "web", inject: [...], external?: [...] }
dsh.bundle = { patch: "./cordis.patch.yml" }
```
- client bundle 是 CJS + 闭包包装：
  `window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })`
- `react` 等外部依赖通过注入的 `require` 解析（模块表），**不是**打进包里
- 宿主扫描 Loader 中声明了 `dsh.client` 的包，合成 `window.__DSH_BOOT__`，
  经 `/plugins/??<pkg>/client.js&rev=...` 提供（`docs/subsystems/client-modules.md`）
- 构建预设：`packages/client/tsdown.client.ts` 的 `clientBundle()`（banner/footer/format cjs）
- 有**纯净度门禁**：client bundle 里禁止跨插件 `import` `@deepseek-ai/*` 的**值**，
  跨插件协作必须走 Cordis 服务 —— 这决定了我们只依赖 `dsh.client.inject` 边 + 服务

**2.3 每轮对话的钩子**
- `ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') ... })`
- `turn/end` 载荷：`{ turn, reason: { kind: 'completed' | 'aborted' | 'error' | 'blocked' | 'max-tokens' | 'interrupted' } }`
  （`packages/core/session/src/types.ts:285`，`TurnEndReasonMap` 在 `:197-224`）
- 顺序保证：`step/end` 先于 `turn/end`；`turn/end` 在 `finally` 中追加，
  **所有退出路径都会发出**（含抛错）；一轮内 `turn/end` 是最后一个事件
- 会话工作目录：`session.header.cwd`（`packages/core/session/src/types.ts:104`），
  **每个会话内不可变**（写入深冻结 header，无任何 mutator）
- 注意区分：`agent/status → 'idle'` **不等价**（只在 inbox 排空时触发，
  一次驱动可能连续产生多个 `turn/end` 而中间没有 idle）；
  且不存在 `agent/turn-end` 事件 —— 轮次边界是 **session** 事件，不是 agent 事件
- `session/event` 监听器是**提交后、fire-and-forget、异常被吞**的：
  我们无法否决轮次，也不会因同步失败影响对话 —— 正是想要的行为

**2.3b 框架内没有 git 能力可复用**
- `dsh-session-checkpoint-policy` 指的是**持久化 flush 检查点**，不是 git 快照；
  框架内**没有任何 git 能力可复用**（`simple-git`/`isomorphic-git`/`nodegit` 全无，
  所有 git 调用都在 `scripts/` 构建工具里）→ git 引擎必须自己写

**2.3c 执行路径与沙箱（关键约束，直接影响架构）**

这是本次调研最重要的发现，它决定了 git 子进程怎么起：

- 文件沙箱与审批**只作用于「经过沙箱化 provider」的调用**：
  - `ctx.fs` 的写入 → 受 `fs-sandbox` 围栏
  - `ctx.shell`（`shell` 服务）→ 由沙箱化执行器用 `ctx.sandbox.confine` 包装，
    **除非** 解析出的 mode 是 `danger-full-access`
  - `ctx.subprocess.spawn`（`subprocess` 服务）→ **完全无沙箱**（spec 里没有策略字段）
  - 组成行里的插件直接 `import { execFile } from 'node:child_process'` → 无沙箱、无审批
- **审批在轮次之外根本不可能拿到**：`ctx.approval` 只被模型面向的工具层
  （`tool-fs` / `tool-bash`）在收到 `sandbox_permissions` 时调用，
  且 `approval.request()` 要求**存在打开的轮次**并有 `agent` + `callId`。
  我们的钩子在 `turn/end`（轮次刚关闭）→ **永远不要指望弹审批**
- 在 `workspace-write` 下，可写根只有 `session cwd` + `/tmp` + `os.tmpdir()`；
  **用户自选的目录（往往在会话工作区之外）会被拒绝**

**结论（架构决策）**：本插件是**组成行里的受信宿主插件**，不是动态 Cordis 包，
也不是模型面向的工具。因此 git 一律走 **`ctx.subprocess`**（无沙箱围栏），
**不要**走 `ctx.shell` —— 否则在默认 `workspace-write` 策略下，
同步用户自选目录会失败关闭（fail-closed），整个功能不可用。
用户自选路径是**用户控制**的，不是模型控制，这正是沙箱围栏不适用它的原因。
（安全上以「只对用户显式选择的目录操作 + 命令级凭据注入 + 提交前敏感文件扫描」自守。）

**2.4c 凭据的精确约定**
- 引用（ref）语法：`/^[A-Za-z_][A-Za-z0-9_]*$/`，例如 `DSH_SYNC_GIT_TOKEN`
- 记录（record）语法：`<scope>/<id>`，每段 `/^[a-z][a-z0-9-]*$/`，
  例如 `dsh-sync-tool/<area-id>`
- 落盘：`$DSH_HOME/.credentials.yaml`（本机已存在，含 1 个 ref + 1 个 grant 记录，
  尚无 git token），写入原子且 mode `0600`
- 分层优先级：**继承的进程环境（只读，最高）** > `.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`
- ⚠️ DSH 会剥离子进程环境里所有匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量
  （`scrubbedParentEnv()`）→ 凭据**必须**通过显式 `env` 传入子进程
- ⚠️ 本机全局 git 配置有 `http.proxy = http://127.0.0.1:7897`，
  推送会走本地代理（需代理在运行）；全局 `credential.helper = manager`
  在非交互子进程里可能弹 GUI → 必须 `GIT_TERMINAL_PROMPT=0`
**2.4 配置与持久化**
- 宿主：`ctx.settings.register(ns, Schema, { base })` → 返回 owner scope；
  `get(ns)` / `watch(cb)` / `update(ns, patch)` / `mutate(ns, ops)` / `replace(ns, section)` / `describe()`
  - 分层：schema 默认值 → composition `base` → 用户层（写入只动用户层）
  - 落盘在 `$DSH_HOME/settings.yaml`（本机已存在该文件）
  - 支持 `role('secret')` 字段与 wire 端 redaction，但官方明确「不是可靠的保密边界」
- 浏览器：`ctx.settingsScope.bind(spec)` → 命名空间作用域的读写（带 revision 栅栏，防并发覆盖）
- 结论：**用户配置走 settings 命名空间 `sync-tool`，不自己造存储层**

**2.4b 凭据（本机已核实签名）**
- `await ctx.credentials.resolve(ref)` → `{ value, source } | undefined`（真正取值的唯一入口）
- `await ctx.credentials.describe(ref)` → `{ configured, source?, writable }`，**永不返回值**
- `await ctx.credentials.set(ref, value)` / `.unset(ref)`（启动环境已提供的 ref 为只读，不可覆盖）
- 私有记录：`credentialKey('<owner>', '<id>')` + `readRecord` / `describeRecord` /
  `listRecords()` / `modifyRecord(key, fn)` / `deleteRecord(key)`
- 引用**没有枚举**（配置文件/schema 才是名字的来源），记录**可以枚举**
- 结论：git token 存进 `ctx.credentials`，settings 里只存**引用名**；
  每个工作区域用一条私有记录 `dsh-sync-tool/<areaId>`，
  设置页用 `describeRecord`/`listRecords` 显示「已设置 / 来源 / 可写」，**永不回显明文**

**2.5 UI 插槽（已按官方 cookbook 修正）**
- 正确落点不是自建 settings 分区，而是 **`settings.plugin.item`**：
  设置 → **Plugins** 分区的「Plugin configuration」标签页，**以命名空间为 key** 自动配对。
  官方 cookbook：`docs/cookbook/adding-a-settings-card.md`
- **配对机制**：Host 注册了命名空间 `sync-tool` → 该标签页就渲染 key 为 `sync-tool` 的卡片；
  Host 半边没注册则不渲染卡片（部署里不留痕迹）。key 即命名空间，天然一致
- Host 半边用 `ctx.settings.installSection(ctx, 'sync-tool', Config, config, { validate, setSource, onChange })`
  —— 把 composition 条目垫在用户文档之下，且**没有 settings provider 时照常工作**
- Client 半边：
  ```ts
  export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']
  export function apply(ctx) {
    const card = new SyncCardController(ctx.settingsScope.bind({ namespace: 'sync-tool' }))
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item', key: 'sync-tool',
      locale: 'settings.syncTool', inject: () => card.inject(),
    }, SyncCard))
  }
  ```
- `scope.set/unset` 按字段写；快照含 `value` / `base` / `user`，
  **`user` 里 key 的存在性**（而非值）才是「被用户覆盖」的标记
- ⚠️ 纯净度门禁禁止跨插件值导入 → 卡片**必须自己渲染自己的控件与表单**，
  不能复用 settings 分区的卡片外壳
- 目录选择：`ctx.directoryPicker.capability()` → `{ kind: 'native', pick(signal) }`（本机已挂
  `dsh-client-ui-directory-picker-native` + `dsh-host-directory-picker-*`）→ 返回绝对路径

**2.6 其他已核实要点**
- 配置 schema 用 **schemastery**（`export const Config = z.object({...})`），不是 zod；
  非法配置在启动时报 `TypeError [ValidationError]: invalid config:` + 逐条 `- <msg> (at <path>)`
- 宿主插件卸载清理：`ctx.on(...)` 注册在调用方 fiber 上；需要等待在途任务时用
  `ctx.effect(function* () { ...; yield async () => { await 收尾 } })`
- 可参考的最接近的现有实现：`packages/goal/goal-round-driver/src/index.ts`
  （inject + generator effect + `ctx.on('session/event')` + `turn/end` 分支 + 排空 disposer）

**2.7 打包与安装（P0 关键，已核实）**

**一个包同时承担三种角色**（这是最省事的形态，无需拆包）：
```
dsh-sync-tool/
├─ package.json        # main/exports["."] → lib/index.js        (宿主半边)
│                      # exports["./client"] → lib/client.js     (浏览器半边)
│                      # dsh.bundle.patch → ./cordis.patch.yml   (安装为 profile 层)
│                      # dsh.client = { platform:"web", inject:[...], external?:[...] }
├─ cordis.patch.yml    # insert 一行 name: dsh-sync-tool（指向包自身）
├─ lib/index.js        # ← 必须预构建
└─ lib/client.js       # ← 必须预构建（缺了会 MissingClientBundleError）
```

**安装命令**：`dsh plugin --profile web add D:\dsh_sync_tool`
- 实现：`spawnSync('pnpm', args, { cwd: <profileDir> })`，然后把
  已安装依赖中声明了 `dsh.bundle.patch` 的**追加进 `dsh.profile.bundles`**
- 相对路径 spec 会被锚定到**调用目录**而非 profile 目录（`add .` 不会自链接 profile）
- 本 profile 目前 `dependencies` 为空、无 lockfile → 这将是它第一次跑 pnpm
- `pnpm-workspace.yaml`：`nodeLinker: hoisted`、`autoInstallPeers: false`；
  peer 依赖（`@deepseek-ai/cordis` 等）由 `$DSH_HOME/profiles/node_modules`
  这个**启动器维护的 fallback**（指向 checkout 的 junction）解析，不需要我们提供

**生效方式（务必记牢，直接影响 P0 调试节奏）**：

| 动作 | 需要重启 profile? | 需要刷新页面? |
|---|---|---|
| 新增 bundle（`dsh plugin add` 追加进 `bundles`） | **是** —— `bundles` 只在启动时读一次 | — |
| 手改 `profiles/web/cordis.patch.yml` 插入行 | **否（live）** —— 两个 user patch 文件被热监听 | 新插入的行需要 F5 |
| 新增客户端行（首次出现） | 视上一行 | **是** —— 浏览器**忽略 `graph` 帧**，只热换已知 id |
| 重建已挂载的 client bundle | 否 | 否（SSE 热换） |
| 重新构建 Web 外壳 | —— | **完全不需要** |

- ⚠️ **没有发布版 `clientBundle` 预设** → 仓库外的包必须**自己复刻** CJS 闭包工厂格式：
  `format: 'cjs'` + `entryFileNames: 'client.js'` +
  banner `window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {` +
  footer `return module.exports; } });` + intro `var module = { exports: {} }; var exports = module.exports;`
- ⚠️ 浏览器半边在**安装前必须已构建**：`main`/`exports["."]` 指向 `lib/index.js`，
  `exports["./client"]` 指向 `lib/client.js`，且都要列进 `files`
- **P0 推荐的开发闭环**（避免每改一行就重启）：
  1. 先 `dsh plugin --profile web add D:\dsh_sync_tool` 装一次依赖（这一步之后不再动 `bundles`）
  2. 之后所有行级迭代都改 `profiles/web/cordis.patch.yml` → **live 生效**
  3. client bundle 改动 → 重建后刷新页面即可

---

## 3. 总体架构

```
                     ┌──────────────────────── 浏览器 (client half) ────────────────────────┐
                     │ Settings → 「同步」分区 (settings.section)                            │
                     │  · 工作区域列表 / 添加 / 移除 / 启用                                  │
                     │  · 远端 URL、分支、凭据引用、自动同步开关、冲突策略                    │
                     │  · 状态徽标 + 最近同步历史 + 错误详情                                 │
                     └───────────────┬──────────────────────────────┬───────────────────────┘
                       settingsScope.bind('sync-tool')        host.call('sync/*')
                                     │                              │
┌────────────────────────────────────┴──────────────────────────────┴───────────────────────┐
│                                  宿主 (host half, profile 平面)                            │
│  ctx.settings.register('sync-tool', Schema)   ← 单一配置真相                               │
│  SyncToolService                                 harness.handle('sync/*')                  │
│   · 工作区域注册表      · 每区域串行队列 + 全局单飞 + 防抖                                  │
│   · 状态机与历史        · ctx.directoryPicker 代客户端调起原生选择器                        │
│  TurnSyncHook: ctx.on('session/event') → turn/end → 选中受影响区域 → 入队                   │
│  GitEngine: 经 ctx.subprocess 跑 git → init/remote/add/commit/fetch/rebase/push           │
│             token 经 env 即时注入，不落盘（见 2.3c / 2.4c）                                │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**平面归属**：本插件提供跨会话的宿主服务、订阅全局会话事件、需要跨会话存活 →
属于**宿主组成（host composition）**。在本机就体现为安装进 `web` profile 的 bundle 行。
不进 agent preset（会话级、随会话卸载，且服务会撞名）。

---

## 4. 目录与包结构（D:\dsh_sync_tool）

```
D:\dsh_sync_tool\
├─ package.json            # name/version/type/exports{".","./client"}/dsh.bundle/dsh.client
├─ cordis.patch.yml        # insert 宿主行（安装后由 profile 合并）
├─ tsdown.config.ts        # 宿主半边：TS → lib/index.js (ESM, @deepseek-ai/* 作 external)
├─ tsdown.client.ts        # 浏览器半边：TSX → lib/client.js（__ModuleLoader__ 包装, CJS）
├─ src/
│  ├─ shared/              # 两侧共享的纯类型/常量（无运行时跨包值依赖）
│  │  ├─ schema.ts         #   schemastery：sync-tool 命名空间 schema
│  │  └─ status.ts         #   SyncStatus 枚举、区域描述类型
│  ├─ host/
│  │  ├─ index.ts          # 插件入口：注册服务、settings 命名空间、RPC、事件钩子
│  │  ├─ service.ts        # SyncToolService（区域注册表、队列、状态机）
│  │  ├─ turn-hook.ts      # turn/end → 防抖 → 选中区域 → 入队
│  │  ├─ engine.ts         # GitEngine：命令序列与结果归类
│  │  ├─ git-exec.ts       # 进程执行封装 + token 注入 + 超时/取消
│  │  ├─ rpc.ts            # harness.handle 方法表（纯 JSON 出入）
│  │  └─ portable.ts       # .dsh-sync.yml 读写（跨机器导入/导出配置）
│  ├─ client/
│  │  ├─ index.ts          # 注册 settings.section 贡献
│  │  ├─ SyncSection.tsx   # 分区页面（React.createElement，不用 JSX 运行时魔法）
│  │  ├─ AreaRow.tsx       # 单个工作区域行 + 状态徽标
│  │  └─ api.ts            # host.call 封装
│  └─ defaults/            # 默认 .gitignore 模板、DSH 资产目录快捷项
├─ tests/                  # git 引擎单测（本地 bare 仓库当远端）+ 端到端双目录验证
└─ README.md / README.zh.md
```

---

## 5. 数据模型

宿主 settings 命名空间 `sync-tool`（落 `$DSH_HOME/settings.yaml`）：

```ts
{
  enabled: boolean,                 // 总开关（默认 true）
  trigger: {
    onTurnEnd: boolean,             // 每轮对话后（默认 true）
    onSessionEnd: boolean,          // 会话结束时（默认 true）
    onStartup: boolean,             // 启动时先 pull（默认 true）
    debounceMs: number,             // 默认 5000
  },
  areas: [{
    id: string,                     // 稳定 id
    name: string,                   // 显示名
    path: string,                   // 绝对路径（本机相关，故不跨机同步）
    remote: string,                 // https://... 或 git@...
    branch: string,                 // 默认 main
    credentialKey?: string,         // 指向 ctx.credentials 的键名，不存明文
    direction: 'both' | 'push' | 'pull',
    enabled: boolean,
    autoCommit: boolean,            // 有变更自动 commit（默认 true）
    commitMessageTemplate: string,  // 默认 'dsh-sync: {host} {turn} {time}'
    extraIgnores: string[],         // 附加忽略规则
    last?: { at, head, ahead, behind, status, error? },
  }],
  historyLimit: number,             // 默认 50
}
```

**跨机器便携清单**：被同步的仓库根可放 `.dsh-sync.yml`，只含**机器无关**字段
（区域名、仓库内相对路径、远端、分支、忽略规则），用于另一台机器「导入配置」。
绝对路径与凭据引用永不出机器。

---

## 6. 同步引擎

### 6.1 单次同步序列（每个区域，串行）
1. 前置校验：路径存在且是目录；`git rev-parse` 判断是否仓库
   - 不是 → `git init -b <branch>` + `git remote add origin <remote>`
   - 无提交且远端有内容 → 直接 `git fetch` + `git checkout <branch>`
2. 若 `autoCommit` 且有变更：写入/校验 `.gitignore` → `git add -A` → `git commit -m <模板>`
   - 无变更则跳过 commit（避免空提交噪声）
3. `git fetch origin <branch> --prune`
4. 分叉判定：
   - 无远端新提交 → 直接 push
   - 有远端新提交且可快进 → 快进后 push
   - 双方都有新提交（`direction: 'both'`）→ `git pull --rebase --autostash`
     - 成功 → push
     - **冲突 → `git rebase --abort` + `git stash list` 复原，标记 `conflict`，停止后续自动同步**
5. `git push origin <branch>`（首次 `-u`）
6. 记录 `last`，发出状态变更事件，写历史

### 6.2 并发与幂等
- 同一区域**串行**；全局**单飞**（同一时刻整个插件最多一个 git 序列，避免磁盘/网络争用）
- 触发合并：防抖窗口内的多次 `turn/end` 合并为一次
- 进程退出前 `ctx.effect` 的 disposer 等待在途任务收尾（或显式标记中断）
- 启动时若有「上次中断」标记，先做一次状态核对再自动同步

### 6.3 安全
- token **绝不**写入 `.git/config`、绝不进提交、绝不进 argv。
  每个 git 命令即时注入，二选一（推荐前者）：
  1. **`GIT_ASKPASS` 临时脚本**（放 `os.tmpdir()`，仅本次同步存在，用完即删）+
     `env: { GIT_ASKPASS: <path>, GIT_TERMINAL_PROMPT: '0' }`
  2. `-c http.extraheader="AUTHORIZATION: basic <base64>"`（不改 argv 里的 URL，但更易进错误输出）
  - 明确**不采用**把 token 拼进 remote URL（会进 argv / `.git/config` / reflog / 报错文本）
- ⚠️ 子进程环境会被 DSH 剥离 `/KEY|PASSWORD|SECRET|TOKEN/i` 变量 → token **必须**显式 `env` 传入
- token 来源：`ctx.credentials`，每次同步**重新 resolve**（官方契约：不得跨操作缓存）
  - 设置页只保存**引用名**（`role('credential-ref')`），值存 `$DSH_HOME/.credentials.yaml`（0600）
  - UI 用 `describe`/`listRecords` 报告「已设置/来源/可写」，**永不回显明文**
- 必须 `GIT_TERMINAL_PROMPT=0`：本机全局 `credential.helper = manager`，
  非交互子进程遇到无缓存凭据会尝试弹 GUI，挂死同步
- 内置忽略：`node_modules/`、`lib/`、`dist/`、`*.log`、`.credentials.yaml`、`settings.yaml`、
  `.git` 递归、会话目录；对命中 `.credentials*` 的文件**拒绝提交并告警**
- 区域路径包含「本插件自身安装目录」时给出明确警告（避免自引用递归）
- **不自设代理、不改全局 git 配置**：本机已有 `http.proxy=http://127.0.0.1:7897`，
  推送走本地代理；若代理未运行则同步失败，错误需原样呈现给用户

### 6.4 触发逻辑
```
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  if (!enabled || !trigger.onTurnEnd) return
  const cwd = session.header.cwd          // 每会话不可变，可直接用
  const selected = areas.filter(a => a.enabled &&
      (a.global || (cwd && isUnder(cwd, a.path))))
  enqueueDebounced(selected, { turn: event.data.turn, reason: event.data.reason })
})
```
- `reason.kind` 处理：`completed` / `error` / `max-tokens` / `blocked` / `interrupted` 一律同步
  （工作区可能已被改动）；`aborted` 默认也同步，可配置关闭
- 监听器是 fire-and-forget 且异常被吞 → 同步失败**绝不影响对话**，
  失败只进插件自己的状态与历史，并在设置页告警
- 因为 `turn/end` 在所有退出路径（含抛错）都会发出，不需要额外兜底钩子
- 补充钩子：`session/disposed` 时同步一次；进程启动时先 pull 一次
- 不用 `agent/turn-stopping`：它是 **await 的**（会拖慢轮次收尾），
  且只表示"即将关闭"，不表示"已完成一轮"

---

## 7. 客户端 UI

**入口**：设置 → **Plugins** 分区 → 「Plugin configuration」标签页中，key 为 `sync-tool` 的卡片
（slot `settings.plugin.item`，见 2.5；与 Host 命名空间自动配对，不新增设置分区）。

- **工作区域**：列表（名称 · 路径 · 远端 · 分支 · 状态徽标 · 开关）
  - `添加工作区域` → `host.call('sync/pickDirectory')` → 宿主调 `ctx.directoryPicker`
    的原生 OS 选择器 → 返回绝对路径 → 新建区域
  - 快捷项：`$DSH_HOME/.agent-presets`、`$DSH_HOME/profiles/<当前>`、本插件源码目录
  - `立即同步` / `移除` / `重命名`
- **仓库设置**：remote、branch、凭据引用、`测试连接`（宿主侧 `git ls-remote`，只读）
- **策略**：总开关、三种触发、防抖、方向、自动提交、提交信息模板、附加忽略
- **状态与历史**：最近 N 次结果、失败原因、`查看 git 输出`（截断后的 stdout/stderr）
- **便携配置**：`导出到仓库` / `从仓库导入`
- 配置读写：`ctx.settingsScope.bind({ ns: 'sync-tool', ... })`（revision 栅栏，避免并发覆盖）
- 渲染：React（`react` 由模块表提供），CSS 由打包器内联注入
- 可选第二阶段：侧边栏/标题栏状态指示器（同步中/失败）

**通信约束**：client→host 单向，仅纯 JSON；不能把 Cordis/DSH 活对象序列化过线。

---

## 8. 跨电脑使用流程

**机器 A（首次）**
1. `dsh plugin --profile web add D:\dsh_sync_tool`（本地目录，pnpm link）
2. 打开 GUI → 设置 → 同步 → 添加工作区域（例如 `D:\dsh_sync_tool` 本身，或 `$DSH_HOME/.agent-presets`）
3. 填远端仓库 URL、分支、凭据 → `测试连接` → `立即同步`（首次会 init + 首推）
4. 之后每轮对话结束自动 commit + push

**机器 B（第二台）**
1. `git clone <远端> <目标目录>`（或让插件执行 clone）
2. `dsh plugin --profile web add D:\dsh_sync_tool`（把插件本体也同步过去）
3. 设置页 `从仓库导入` 读取 `.dsh-sync.yml`，按本机路径改写区域路径 → 开启自动同步

如此「插件本体 + 预设 + 技能」都随同一个仓库在两台机器间流动。

---

## 9. 实施阶段

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| P0 | 包骨架（含手写 CJS 工厂 tsdown 配置）+ bundle 行 + 客户端空卡片 + 预构建 + 安装 | 安装后**重启 profile**、刷新页面，能在 Plugins→Plugin configuration 看到 key 为 `sync-tool` 的空卡片；`dsh --profile web --dump-config` 可见行 |
| P1 | settings 命名空间（`installSection`）+ 区域 CRUD + 目录选择 RPC | 能添加/删除区域并持久化，重启后仍在 |
| P2 | GitEngine + 手动「立即同步」+ 状态与历史 | 本地 bare 仓库当远端，手动同步成功；冲突时停在 conflict |
| P3 | `turn/end` 钩子 + 防抖 + 单飞队列 | 一轮对话改动文件后自动出现在远端；连续多轮不产生堆积 |
| P4 | 跨机验证 + 便携清单 + 文档 + （可选）状态指示器 | 双目录对同一 bare 远端完成双向同步；README 可用 |

## 10. 验证方案

- **单元**：GitEngine 对本地 bare 仓库（`git init --bare`）跑全序列，
  覆盖：首次推送、无变更、快进、分叉后 rebase 成功、**人为冲突后停住且工作区未损坏**、网络失败重试
- **端到端**：目录 A 与 B 指向同一 bare 远端；A 触发 `turn/end` → 断言远端更新 → B 同步后内容一致
- **配置**：`dsh --profile web --dump-config` 确认 bundle 层与行合并正确
- **UI**：刷新 `http://127.0.0.1:3080`，确认设置分区渲染、目录选择器可弹起、状态可刷新
- **回归**：确认插件未向模型注册任何工具（工具列表不变）

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| **沙箱**：`workspace-write` 下用户自选目录在会话工作区之外会被拒绝，且轮次外无法申请审批 | git 走 `ctx.subprocess`（不受沙箱围栏），**不走 `ctx.shell`**；见 2.3c |
| 客户端半边必须**预构建**（否则 `MissingClientBundleError`） | 随包发布 `lib/client.js` + `lib/index.js`；P0 先打通最小闭环 |
| **新增 bundle 必须重启 profile**；新增客户端行必须**刷新页面**（浏览器忽略 `graph` 帧） | P0 调试闭环改为「装一次依赖，之后只改 `profiles/web/cordis.patch.yml`」→ live 生效；页面刷新即可 |
| 仓库外无 `clientBundle` 预设可用 | 手写 CJS 闭包工厂的 tsdown 配置（banner/footer/intro/format/entryFileNames，见 2.7） |
| 每轮 git 操作的开销/噪声（大仓库、二进制） | 忽略规则 + 体积/文件数阈值 + 变更为空则跳过 + 防抖 |
| 自动 rebase 造成用户文件损坏 | 冲突一律 `rebase --abort` 停住，绝不自动解决；保留 autostash |
| token 泄露 | 只走 credentials，`GIT_ASKPASS` 命令级注入，不落盘不进 argv；提交前扫描敏感文件名 |
| **子进程环境剥离** `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 导致认证失败 | token 显式经 `env` 传入；`GIT_TERMINAL_PROMPT=0` 防 GUI 挂死 |
| **本机全局 `http.proxy=127.0.0.1:7897`**，代理未运行则推送失败 | 不改全局配置；把 git 原始 stderr 原样呈现，错误可诊断 |
| 同步 `.dsh` 时把自己/依赖卷进去 | 内置忽略 + 自引用检测 + 默认只同步显式选择的区域 |
| 多机同时编辑 | rebase + 停冲突；文档明确建议单机为主编辑 |
| 跨机绝对路径不同 | 便携清单只存机器无关字段，路径在导入时重写 |

## 12. 已确认的设计决策（用户已拍板）

1. **工作区域范围**：任意文件夹都支持；设置页额外提供 DSH 资产快捷项
   （`$DSH_HOME/.agent-presets`、当前 profile、本插件源码目录、skills 目录）。
2. **默认冲突策略**：`git pull --rebase --autostash`；一旦冲突则 `rebase --abort` 复原、
   标记 `conflict`、停止该区域的自动同步并告警 —— 绝不自动解决冲突、绝不损坏用户文件。
3. **默认同步方向**：双向（先 pull 再 push），以实现两台机器内容真正一致。

由此确定的默认值：`direction: 'both'`、`autoCommit: true`、`onTurnEnd: true`、
`onSessionEnd: true`、`onStartup: true`、`debounceMs: 5000`。

---

## 13. 实施结果与本方案的偏差（收尾记录）

方案落地后与本文件最初设想不一致的地方，按「实际做法 / 原因」记录：

| 最初设想 | 实际做法 | 原因 |
|---|---|---|
| 便携清单 `.dsh-sync.yml` | **`.dsh-sync.json`** | 避免引入 YAML 依赖（宿主半边只依赖 schemastery），JSON 自带解析 |
| 卡片放进自建 `settings.section` | **`settings.plugin.item`**，key 为命名空间 | 官方 cookbook 的做法：与 Host 命名空间**自动配对**，且官方明确不建议跨插件值导入 |
| 页面右上角「小按钮」 | **`conversation.session.header.utilities`** | 该插槽文档原文 "Right-aligned Session utilities in ascending order"，`header.corner` 是 `kind: 'single'` 已被占用，无法追加 |
| 客户端→宿主用自定义 Remote 命名空间 | **settings 命名空间 + 请求令牌** | 仓库外没有生成的 Typert Remote 契约；settings 是唯一有文档的写通道 |
| 目录选择自己实现 | **复用已挂载的 `ctx.remote.directoryPicker`** | 本机已挂 `dsh-host-directory-picker-native`；不可用时退化为手动输入绝对路径 |
| 用 `dsh plugin add` 做开发安装 | 依赖用 `pnpm add link:`，行写在 `cordis.patch.yml` | `dsh plugin add` 会同时写进 `bundles`，而 `bundles` 只在启动时读一次 → 需要重启；走 patch 层是 **live** 的 |
| 「启动时同步」默认开 | 默认**关**（`syncOnStartup: false`） | 启动即推送对用户过于激进 |

### 真实测试发现并修复的缺陷

1. **提交缺身份**（Linux 真机发现）：引擎从不提供 author/committer，任何**没配过 git 身份的机器**
   （正是跨机流程里「第二台机器」的常态）每次自动提交都以 `Author identity unknown` 失败。
   现改为：先用机器自身身份；**仅当** git 因缺身份拒绝时，用配置的 `commitIdentity` 或派生的
   `dsh-sync@<hostname>` **重试一次**，并在状态里明示。真实身份永不被覆盖。
   （commit `7aae0d9`；对照测试确保「确实先被拒绝」，不会空转通过）
2. **ahead/behind 报告过期**（同一轮真机输出里发现）：计数在推送**之前**读取，
   刚推送成功的区域仍报 `领先 1`。现改为推送后重读（commit `ea4ba68`）。
3. **状态条目丢 `id`**：复用已存结果时丢掉了 schema 要求的 `id`，
   真实 settings provider 会**拒绝整份文档并静默冻结状态**（集成测试抓到，P3 已修）。
4. **空远端取单个 refspec**：`git fetch origin <branch>` 在远端尚无该分支时致命失败，
   导致首次推送失败。改为取远端全部 refs（P2 已修）。

### 明确未验证

见 README「验证记录」表末：真实 LLM 轮次驱动 `turn/end`、需认证的 HTTPS 推送、
浏览器里的视觉呈现、一次性任务模式下的同步（已知边界）、真实独立服务器
（目标 VPS 的 22 端口在这条网络路径上被整体阻断，与那台机器无关）。

