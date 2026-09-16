# 方案：同步配置搬到工作区右上角

> 状态：**已实现并通过验证**（见 §13 实现记录）。
> 本文只写核实过的事实；推测与待办单独标注。

## 1. 你要的改动（我的复述）

1. 现在插件自己那套「工作区域列表」概念是错的。DSH 已经有「工作区」：**一个文件夹 = 一个工作区，工作区里可以有多个对话**（你第二张图的左侧列表）。
2. 同步配置从「设置 → Plugins → 配置卡片」搬到**右上角一个独立的配置按钮**。
3. 点开是一个**二级面板**，里面**只需要填一个远程仓库地址**。
4. 填完之后，插件**自动把这个工作区里的每一轮对话都同步**到那个仓库。

## 2. 我对语义的理解（如果有偏差请直接说，这是方案的地基）

- **一个工作区 → 一个仓库**：你在哪个工作区里填的地址，就只作用于这个工作区（不是"一个仓库管所有工作区"）。
- 第二台机器：把仓库 clone 成文件夹 → 作为工作区打开 → 插件从文件夹里的 `.dsh-sync.json` 认出远端，**零输入**接管。
- "每一轮对话都同步" = 该工作区目录下的**所有会话**（多个对话框各一条）每轮结束都导出、提交、推送。

## 3. 现在错在哪（对着你两张图）

| 现象 | 根因 |
|---|---|
| 卡片里让你"选择目录并添加"，还要填名称/分支/凭据/方向/自动提交/忽略规则 | 插件自建了一套 `areas[]` 概念，跟 DSH 的工作区重复了一遍 |
| 右上角那个指示器跟眼前的工作区没关系，它汇总的是"全插件所有 area" | 它读的是全局配置，**根本没看当前会话/当前工作区** |
| 工作区在 DSH 侧栏已经有了，插件里却又要维护一遍 | 同一个文件夹被描述两次，而且两边可能不一致 |

**结论**：应该把「同步单位」对齐 DSH 的工作区，「配置入口」收窄成"给当前工作区填一个远端"。

## 4. 已核实的机制事实（决定这个方案能不能成立）

### 4.1 右上角的插槽存在，而且数据全都现成

- `conversation.session.header.utilities` = `{ kind: 'list', scope: 'session' }`，
  文档原话 "Right-aligned Session utilities in ascending order"
  （`packages/client/ui-conversation/src/client/contract/slots.ts:138-143`；
  渲染点 `skeleton/ConversationSession.tsx:133-138` 的 `.headerUtilities`，CSS `margin-left:20px` 靠右）。
  相邻的 `conversation.session.header.corner` 是 `kind:'single'` 且**已被 ui-sidebar-right 的
  ExpandButton 以 priority 0 占住** —— 同 priority 注册会抛，改 priority 就是顶掉它（用户失去右侧栏开关），
  **不要碰**。`header.actions` 在左边（贴面包屑），也不是右上角。
- **排序语义**：list 的左右顺序只看 `order`（`client/ui-renderer/src/client/scoped-slots.tsx:861`），
  `priority` 只决定"同一个 id 谁顶掉谁"。已占的两个 occupant（open-in-app、session-log-download）
  都是默认 `order: 0` ⇒ 我们用**新 id + `order: 200`** 就落在最右。
- **这个座位拿得到的数据**（`slot-catalog.ts:1229-1244` 的 standardProps，来自
  `ui-session/src/client/index.ts:104-129` 的标准座位）：
  | 要什么 | 怎么拿 |
  |---|---|
  | 当前会话 id | `props.sessionId`（直给） |
  | 当前会话快照 / 是否 live | `props.useSession(s => s.openState)` / `.running` / `.blank` |
  | **cwd** | `props.useSessions(s => s.byId[sessionId]?.cwd)`（`SessionSnapshot` 里没有 cwd，`SessionSummary` 里有） |
  | **所属工作区** | `props.useWorkspaces(s => s.items.find(w => w.sessionIds.includes(sessionId)))` → `{ workspaceId, path, sessionIds }` |
- **官方先例就在同一个 header 里**：`ui-open-in-app` 用 `useSessions` 取 cwd
  （`ui-open-in-app/src/client/OpenInAppAction.tsx:129-131`），
  `ui-conversation` 自己也是这么算当前工作区的
  （`skeleton/ConversationRoot.tsx:237-239`；ui-workspace 把它抽成了 `tree.ts:23-35` 的 `owningGroupKey`）。
  ⇒ 按钮**不需要任何额外管线**就知道"当前会话属于哪个工作区"。
- ⚠️ **一个限制**：header 在 **blank 会话**（新会话还没发第一句）时整条隐藏
  （`ConversationSession.tsx:69,76` 的 `hideChrome`），没有当前会话时 header 根本不渲染
  （`ConversationRoot.tsx:374`）。三个 hero 席位（`hero.workspace`/`hero.agentPreset`/`hero.brand.mark`）
  要么已被占用、要么语义不符，`shell.overlay` 是整帧浮层（位置语义不对）。
  ⇒ **兜底就交给保留的 Plugins 卡片**（见 4.7）：空白工作区/新会话状态下，卡片照样能配。
  这是"卡片保留"的第二个理由。

### 4.2 弹层有官方原语，不用自己造

客户端 bundle 的工厂 `require` 能取到的 specifier 是 shell 的**冻结模块表**：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
**`@deepseek-ai/dsh-client-ui-primitives`**、`@deepseek-ai/dsh-client-ui-dockkit`
（`packages/client/web/src/seed.ts:24-39` 与 `platform.ts:8-14`）。

`ui-primitives` 里我需要的都有：`Input`、`Button`、`Switch`、`Pill`、`Tag`、`StateDot`、
`Tooltip`、`DisclosureRow`、`useAnchoredPosition`、`useAnchoredMaxHeight`、
`useDismissOnOutsidePointer`、`writeClipboard`、`relativeTime`、一整套图标。

既有的"锚定面板"标准写法有**同一 header 里的现成模板**：`ui-schedule` 的
`conversation.session.header.actions` 贡献（`ScheduleCatalogAction.tsx:111-208`）——
`useAnchoredPosition({open, anchorRef, panelRef, side:'bottom', gap, margin})` +
`useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)` + Escape 关闭并归位焦点 +
`createPortal(..., document.body)`。`Menu` 只能装"一串菜单项"，装不下输入框，
所以我们的面板走这条自渲染路线（`Input`/`Button`/`Tooltip` 从 primitives 取）。
注意：`corner` 席位已被右侧栏的 ExpandButton 以 priority 0 占住，同 priority 注册会**抛错**，
改 priority 等于顶掉它 —— 所以**只用 utilities，不碰 corner**。

### 4.3 DSH 工作区是宿主侧真实服务；归属要用 sessionIds，不能只看 cwd

- 宿主侧服务名是 **`ctx.workspaceRegistry`**（`WorkspaceRegistry extends Service`，
  `packages/workspace/workspace/src/index.ts:91-115`）。注意 `ctx.workspaces` 是**浏览器侧**的另一个服务
  （`packages/api/workspace-controller/src/client/service.ts:88`），宿主里取它是 `undefined`。
- 记录落在 `$DSH_HOME/storages/workspace.json`（整个 domain 一个文档）。**只能读，不要写**：
  没有文件监听、内存权威（下次任意写会整文件覆盖）、schema/version/跨字段不变式写错会
  让 `dsh-workspace` 这一行**启动失败**。
- `create(path)` 走 `fs.realpath` 规范化；`resolveByPath(path)` 回答"哪个工作区拥有这个目录"。
- **会话归属的权威是记录里的 `sessionIds`**，读时再按 canonical cwd 过滤
  （`entity.ts:101-103`）。官方文档原话：*"Ownership truth is the record's ordered `sessionIds`,
  never derived from session cwd — but membership requires both"*（`docs/subsystems/workspace.md:116`）。
- ⚠️ **`session.header.cwd` 不能直接当工作区路径**，反例都在代码里：
  1. `cwd` 是可选项，可能 `undefined`；
  2. 子目录会话 canonical 不等 ⇒ 不属于父工作区（DSH 会给子目录**另建一个工作区**）；
  3. symlink/短名/带 `..` 的写法与 `realpath` 后的 `workspace.path` 逐字不等；
  4. 工作区删掉重建会得到**新 uuid 且 sessionIds 为空**（`path` 不变）；
  5. DSH 自己就存在两种口径：`session-reference` 用逐字比较，workspace 用 realpath 比较。

⇒ **插件的归属判定顺序**（从权威到兜底）：
1. `ctx.workspaceRegistry` 里 `sessionIds` 含该会话的工作区（权威）；
2. `resolveByPath(session.header.cwd)` 命中的工作区（canonical 兜底）；
3. 该会话"s由本工作区导入过"（机器本地记账，用于 B 机续聊的发布回路）。

配置的键用 **canonical 工作区路径**（`workspace.path`），不用 `WorkspaceId`（它不稳定、也不跨机）。

**谁来产出这个键**：客户端不去猜路径 —— 客户端的工作区投影里带的 `path` 就是宿主记录里的
`record.path`（已经是 realpath）。所以面板写入的是 `{ path: <工作区投影里的 path>, remote }`，
宿主同步时再用 `resolveByPath(path)` 复核一次；复核不到（目录被删/改名）就退回按写入的路径字符串处理，
并在面板上把工作区标成"目录不存在"。

### 4.4 ⚠️ 跨机使用的前提：两台机器的工作区路径必须一致

这是本方案最重要的一条使用约束，代码可确认：

- 工作区归属要求 `realpath(header.cwd) === workspace.path`（`index.ts:571-589`、`entity.ts:114-148`）。
- 会话归档里记录的 `cwd` 是 A 机的路径。到了 B 机，如果那个路径**不存在**：
  - 会话的 canonical 校验失败 ⇒ **不属于任何工作区** ⇒ 在侧栏落到"未分组"，导出侧的"工作区归属"也看不到它；
  - 文件/命令类工具以 `session.header.cwd` 为基准，路径不存在时工具自己会失败。
- 反过来，**两台机器用同一个绝对路径**时：会话照常归入工作区、缓存前缀一致、工具可用 —— 全部成立。

⇒ 方案里要：
1. 在面板里把"当前工作区路径"显示出来（用户一眼能看到两台机器是否一致）；
2. 检测到"本机导入的会话，其记录 cwd 在本机不存在"时，在面板上给一条明确提示，
   并给出两个选项：把工作区放到同样的路径（推荐）／改用 `cwdPolicy: auto` 把 cwd 改写成本机路径
   （能用，但**会作废前缀缓存**）。
3. README 的"跨电脑使用"把它写成第一步，而不是脚注。

### 4.5 会话枚举：以工作区成员为准，并集兜底

宿主侧可用的枚举面（可靠度从高到低）：
- `workspaceRegistry.get(id).sessionIds` —— 权威成员、已按 canonical cwd 过滤、**包含 live 会话**；
- `ctx.sessionPersistence.list()` —— 全部可见会话（含本进程刚创建、尚未落盘的）；
- `ctx.sessionQuery.listSessions()` —— 全量逻辑语料（含 live、含无 cwd）。

⇒ 导出侧的集合 = **工作区 `sessionIds` ∪ canonical cwd 命中的会话 ∪ 本工作区导入过的会话**。
第三项是必需的：B 机上导入的会话如果 cwd 在本机不存在，它**不会**出现在 `sessionIds` 里，
少了这一项，B 机的续聊就永远发布不回去。

### 4.6 变更信号

没有任何 `workspace/*` 事件。唯一信号是泛化的 `domain/changed`
（`packages/storage/storage-domain/src/events.ts:36-47`），
`change.domain === 'workspace'` 时 `table === 'workspaces'` 是单条记录变更、`table === ''` 是全局顺序/归档集。
**监听时必须先按 `change.domain` 过滤**（否则会被 `session_projcache` 的写刷爆）。
本方案不依赖它：同步由 `turn/end` 驱动，面板由客户端自己的响应式服务驱动。


### 4.7 Plugins 卡片保留，但换角色

已定（你拍的）：**卡片保留**，作用是"兜底入口 + 状态总览"，不再是主配置入口。

- 主入口 = 右上角按钮（在哪个工作区里，就配哪个工作区）。
- 卡片 = **兜底入口 + 状态总览**：
  - 空白工作区 / 新会话（header 被隐藏）时，只能从这里配 —— 这不是退而求其次，
    是"按钮在 blank 会话不可见"这个框架限制的必然兜底；
  - 一屏列出 **DSH 的工作区**（客户端 `useWorkspaces` → `WorkspaceView[]`）与它们的同步状态、
    HEAD、领先/落后、最近历史；
  - 全局开关（总开关、每轮同步、启动同步、防抖、提交身份、会话同步默认项）。
- 卡片里**不再需要**"选择目录并添加 / 从仓库导入"这类动作 —— 工作区由 DSH 创建，插件只挂同步配置。

改法上这只是"保留现有 `settings.plugin.item` 注册、换掉内容"（key 仍是 `sync-tool` 命名空间），
比删卡片改动更小。（参考：`ui-settings-plugins` 只渲染显式登记过卡片的命名空间，
`packages/client/ui-settings-plugins/src/client/index.ts:68-73,100`；
命名空间继续由 Host 的 `installSection` serve，卡片就一定会被 dispatch。）

## 4.8 仓库拓扑：我的建议（回答你的纠结）

> ⚠️ 这一节被 **4.9** 修正过：拓扑不是"每个工作区一个仓库"，而是**按文件夹是否已有仓库**分成
> 模式 F（无仓库 → 用文件夹自己的仓库）与模式 S（已有仓库 → 只把会话送到一个共享会话仓库）。
> 下面保留推理过程与那条硬约束。

先摆一条**代码层面确认的硬约束**，它决定了哪些拓扑根本不可行：

> 现在的模型是"在**工作区文件夹里直接** `git init` / commit / push"。
> 所以**同一个远端 URL 不能配给两个工作区**：第二个工作区本地是另一条互不相关的历史，
> push 会被拒，走到 `pull --rebase` 时因为历史无关直接冲突，插件会把它标成 `conflict`
> （不会静默覆盖，但也用不了）。

因此"填一次链接、所有工作区都同步到它"在现模型下**不成立**。可行的是三种：

| 拓扑 | 说明 | 代价 |
|---|---|---|
| **A. 每个工作区一个仓库**（推荐） | 工作区文件夹就是仓库，会话写在它的 `.dsh-sessions/` 里一起走 | GitHub 上每个同步的工作区一个仓库 |
| B. 一个工作区 → 某个已有仓库的**子目录** | 需要把文件**镜像**到 `$DSH_HOME/sync-tool/mirrors/…` 再推送，不再是"在文件夹里直接 git" | 多一套镜像/回收逻辑，文件夹本体不再被 git 管理 |
| C. **集中"会话仓库"**：只把各工作区的 `.dsh-sessions/` 镜像进一个仓库的 `<工作区名>/` 子目录 | 仓库数最多 +1；文件夹里的其它文件完全不碰 | 文件夹内容不同步（只能同步对话） |

**我的建议：v1 只做 A，并且把"新建仓库"这件事的摩擦降到最低：**

1. **面板自动探测**：文件夹里已经有 `git remote origin` 时，打开面板就把 URL **预填**好 —— 你的
   `myWeb`、`quantizePersonality`、`AudioReassigner`、`dsh_sync_tool` 这些项目**本来就有仓库**，
   于是多数情况下你一个字都不用打，也**不会新建任何仓库**。
2. **只有你主动填了远端的工作区才同步**。侧栏那 8 个文件夹里，真正要同步的是少数；
   仓库数量 = 你本来有的项目仓库数量，**不是**工作区数量。
3. **会话记录不会额外增加仓库**：它跟着所在工作区的仓库走。
4. 真正让人纠结的只有一类：**不是项目的文件夹**（笔记、`docs`、预设目录）。
   对这种，A 意味着每个都建一个仓库 —— 如果你不喜欢，再上 **C**（集中会话仓库）：
   它其实很小（镜像 = 复制 `.dsh-sessions/` 到 mirror 目录，然后复用现有 git 引擎跑一遍），
   但它是**第二套放置模式**，我建议等 v1 跑顺了单独做，别混在这一次改动里。

如果你现在就想要 C，告诉我，我把它并进 v1（配置里加一个 `mode: 'folder' | 'sessions'`，
`sessions` 模式只镜像归档目录）。

## 4.9 ⚠️ 文件夹**本来就有 git 仓库**时怎么办（本方案最关键的修正）

你指出的这一条推翻了"填个 URL 就行"的简单设想。实际有四种情形，必须分开处理：

| # | 文件夹状态 | 现状（`git.js`）会怎么做 | 问题 |
|---|---|---|---|
| 1 | 不是仓库 | `git init` + 全量 `add -A` + commit + push | ✅ 正确，这就是原功能（DSH 资产/笔记目录） |
| 2 | 是仓库、有 `origin` | `remote set-url`（如果 URL 不同）+ **`add -A` 全量提交** + fetch/rebase + push | ❌ **接管了用户的项目仓库**：把未完成的 WIP 自动提交并推送；`pull --rebase` 会改写用户的本地提交；`.dsh-sessions/` 混进项目历史；如果仓库是公开/团队的，**对话内容会被推上去** |
| 3 | 是仓库、没有 `origin` | 加 remote，然后同上 | 同 2 的提交部分 |
| 4 | 在**另一个仓库内部**（子目录） | `nestedRepos: 'init'` → 在父仓库工作树里**再建一个独立仓库** | ❌ 会在用户项目里留下一个未跟踪的嵌套 `.git`，很容易被误提交 |

### 结论：按"文件夹是不是已经有仓库"分两种模式

**模式 F（folder，全量）** —— 只用于**不是仓库**的文件夹（DSH 资产、预设、笔记、技能目录）：
填一个远端 URL → `init` + 全量提交 + 双向同步。这是原功能，保持不变。

**模式 S（sessions，只同步会话）** —— 用于**已经是你的仓库**的文件夹（你的项目）：
**插件完全不碰这个仓库的文件**，只把该工作区的**会话记录**送到一个**共享的会话仓库**。
项目仓库的 WIP、分支、历史、远端一律不动，也永远不会自动提交你的代码改动。

于是拓扑变成（这也顺带回答了"GitHub 会不会乱"）：

```
你的项目文件夹（已有仓库）  ──►  不碰，原样
        └─ 会话记录 ──────────►  ┐
                                 ├─►  一个共享的「会话仓库」（最多 +1 个仓库）
别的项目文件夹（已有仓库）  ──►  ┘         <工作区名>/session-*.jsonl.zstd
        └─ 会话记录 ──────────►
DSH 资产/笔记文件夹（无仓库）───►  自己的仓库（模式 F，含 .dsh-sessions/）
```

模式 S 的实现（比想象中小，因为**复用现有 git 引擎**）：
- 在 `$DSH_HOME/sync-tool/sessions-repo/` 维护一个**镜像工作树**（插件自己的仓库，没有用户 WIP，所以全量自动提交是安全的）；
- 每轮：把各工作区的 `.dsh-sessions/` 复制到 `<镜像>/<工作区名>/` → 在**镜像**上跑一遍现有的
  `commit → fetch → 快进/rebase → push`（认证、身份回退、冲突中止全都白拿）；
- 拉取侧：镜像合并完成后，把 `<镜像>/<工作区名>/` 复制回该工作区的 `.dsh-sessions/`，
  再走现成的会话导入逻辑；
- 工作区名冲突时加短哈希后缀；镜像里**只有归档目录**，所以不存在把项目文件带进去的可能。

**模式 F/S 由插件自动判定**（`rev-parse --show-toplevel`）：
- 不是仓库 → 模式 F；
- 是仓库（含"在父仓库内部"）→ **默认模式 S**；
- 想在项目仓库里也自动提交文件夹改动（例如你自己的私人小项目）→ 面板里显式打开
  "连同我的改动一起提交"，此时才回到 `add -A`，并且默认 `direction: push`（不自动 rebase 你的分支）。
- 情形 4（在父仓库内部）**不再默认建嵌套仓库**：默认按模式 S 处理；想建独立仓库是显式的高级选项，
  且会提示"会在父仓库里留下未跟踪的 `.git`"。

### 面板在这三种情形下长什么样

情形 1（不是仓库）：
```
这个文件夹还不是 git 仓库。
远程仓库 [ https://github.com/you/<repo>.git ]
[ 保存并同步 ]     保存后：init + 提交 + 推送（含会话记录）
```

情形 2/3（已经是仓库）：
```
这个文件夹已经是一个 git 仓库。
  远端   https://github.com/you/myWeb.git   （分支 feature/x，3 个未提交文件）
插件不会动这个仓库的文件、分支和提交。
它只把这里的对话记录同步到你的会话仓库：
  会话仓库 [ https://github.com/you/dsh-sessions.git ]
[ 保存并同步 ]
  ▸ 高级：改为"连同我的改动一起提交"（会在本仓库自动 commit + push 当前分支）
         改为"只在本仓库提交 .dsh-sessions/"（对话跟项目走，不进共享仓库）
```

情形 4（在父仓库内部）：
```
这个文件夹在另一个 git 仓库内部（仓库根：D:\myWeb）。
插件不会在这里建独立仓库。对话记录会同步到你的会话仓库。
[ 保存并同步 ]   ▸ 高级：仍然在文件夹内建立独立仓库（会在父仓库留下未跟踪的 .git）
```

**公开仓库警告**：选择"对话进项目仓库"这两个高级选项时，面板明确写一句
"如果这个仓库是公开的或与别人共享，你的对话内容会一起被推送"。

### 5.1 概念

- **同步单位 = 工作区文件夹**，配置项只有一句："把这个文件夹同步到哪个远端仓库"。
- 键 = 本机**绝对路径**（规范化后）；显示名 = 文件夹名。
- 只有**填了远端仓库的工作区**才同步，其它工作区完全无感。
- 插件不再有"添加/删除工作区域"的动作，也不再有目录选择器。

### 5.2 配置（`sync-tool` 命名空间）

`areas[]` → `workspaces[]`，`mode` 由插件自动判定，用户通常只需要填**一个**地址：

```yaml
sync-tool:
  enabled: true
  syncOnTurnEnd: true
  # 模式 S 用的共享会话仓库：一次配置，所有"已有自己仓库"的工作区共用
  sessionsRemote: https://example.com/you/dsh-sessions.git
  workspaces:
    # 情形 1：文件夹不是仓库 → 模式 F，全量同步（含会话记录）
    - path: D:\work\dsh-assets
      mode: folder
      remote: https://example.com/you/dsh-assets.git   # ← 面板里唯一要填的东西

    # 情形 2/3：文件夹已经是你的项目仓库 → 模式 S，插件不碰这个仓库
    - path: D:\work\myWeb
      mode: sessions          # 只把对话送到上面的 sessionsRemote
      # 高级：想连文件夹改动一起自动提交时才需要这些
      # mode: folder
      # remote: https://example.com/you/myWeb.git
      # autoCommit: true
      # direction: push

      # 以下全部有默认值，面板里折叠在「高级」
      branch: main
      direction: both
      credentialRef: ""
      extraIgnores: []
      guardSensitive: true
      nestedRepos: refuse     # 默认不再在父仓库内部建嵌套仓库（见 4.9 情形 4）
      sessions:
        enabled: true
        dir: .dsh-sessions
        compression: zstd
        cwdPolicy: keep
        hintOnDeviceSwitch: true
```

**迁移**：加载时把旧 `areas[]` 按 `path` 折进 `workspaces[]`（各自的高级项保留），旧字段不再读取。
老用户不会丢配置，也不会看到"另一个列表"。

### 5.3 右上角：一个按钮 + 一个二级面板

**按钮**（`conversation.session.header.utilities`，新 `id`，`order: 200` = 该行最右）：

- 图标 = 齿轮/云；右侧一个状态点（`StateDot`，复用现有四态：待同步/同步中/已同步/冲突/错误）。
- 未配置远端 → 图标 + "未同步"；已配置 → 图标 + 状态。
- 当前会话没有 `cwd`（hero、空白会话）→ **不渲染**。
- 点击 = 打开面板；`aria-expanded` / `aria-haspopup` 齐备。

**面板**（锚定在按钮下方、点外关闭、Esc 关闭、视口内夹紧）：

```
┌─────────────────────────────────────────────┐
│ myWeb                                    ×  │   ← 文件夹名
│ D:\work\myWeb                        ⧉      │   ← 完整路径（点击复制）
├─────────────────────────────────────────────┤
│ 远程仓库                                     │
│ [ https://github.com/you/myWeb.git       ]  │   ← 唯一必填项
│                                             │
│ [ 保存并同步 ]  [ 立即同步 ]                 │
├─────────────────────────────────────────────┤
│ ✓ 已同步 · 3 分钟前 · HEAD a1b2c3d           │   ← 最近一次结果
├─────────────────────────────────────────────┤
│ ▸ 高级                                       │   ← 折叠：分支/方向/凭据/
│                                               │      忽略规则/是否同步会话记录
│ 取消同步                                     │   ← 从配置里移除这一项
└─────────────────────────────────────────────┘
```

**认领提示**：如果这个文件夹里已经有 `.dsh-sync.json`（另一台机器同步过）而本机还没配置，
面板顶部显示一行：

> 这个文件夹已由另一台机器同步过（远端 …）。[ 启用 ]

点一下就等于填好远端 —— 这就是第二台机器的零输入路径。

### 5.4 运行时（基本沿用现有实现，只换"找谁"）

```
turn/end
  → 由当前会话找它的工作区（顺序见 4.3）→ 在 workspaces[] 里找这一项（没有 → 什么都不做）
  → 导出该工作区的会话（写 .dsh-sessions/）
  → 提交 → fetch → 快进/rebase → 导入会话 → push
```

- 每轮只同步**当前工作区**（原来那个"每轮同步全部区域"降级成高级项，默认关）。
- 状态文档从"每个 area id"改成"每个工作区路径"；历史与详情文案不变。
- 会话归档格式、导入路径、设备提示**一行都不用改**（已经实测通过）。

### 5.5 会话范围

按 DSH 的分组口径取**精确匹配**（会话 cwd canonical 之后 == 工作区路径），默认行为与你在侧栏看到的一致。

`includeDescendants` 从"默认开"改成**默认关**，理由是调研里确认的一件事：
子目录会话在 DSH 里 canonical 不相等 ⇒ **不属于父工作区**，bootstrap 甚至会为它
**单独建一个工作区**（`packages/workspace/workspace/src/index.ts:425-507` 按 canonical cwd 分组建记录）。
所以"把子目录里的会话也算进来"其实是插件自己的越界定义，默认不应该开。

同样地，`archivedSessionIds` 是 registry 的全局归档集，**归档不会清空工作区归属**
（`index.ts:226-234` 注释逐字 "Archiving never touches workspace accounting"）。
本方案**不**尊重归档：归档只影响侧栏展示，不影响"这个文件夹的对话要不要同步"。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/host/index.js` | schema `areas[]`→`workspaces[]`（含迁移）；pass 选择改成"由会话找所属工作区"；状态文档键换路径；命令通道不变 |
| `src/host/workspaces.js`（新增） | 归属解析：`workspaceRegistry.list()/resolveByPath()` + `sessionIds` 反查；取不到服务时降级为 canonical cwd 比较（老实现）+ 机器本地记账 |
| `src/host/sessions.js` | 导出集合 = 工作区 `sessionIds` ∪ canonical cwd 命中 ∪ 本工作区导入过；`areaId` → 工作区路径键；`includeDescendants` 默认 `false` |
| `src/host/git.js` | 新增 `commitPaths`（只提交指定路径，用 `git commit -m … -- <path>`，不动用户已暂存的其它改动）；`nestedRepos` 默认从 `init` 改成 `refuse`；`direction` 默认值可由"文件夹是否已有仓库"推导 |
| `src/host/mirror.js`（新增，模式 S） | 共享会话仓库的镜像工作树：把各工作区的 `.dsh-sessions/` 复制进 `<镜像>/<工作区名>/`，在镜像上跑现有 git 序列，合并后再复制回来 |
| `src/host/notice.js` | 不用改 |
| `src/client/index.js` | 删卡片；改成"按钮 + 锚定面板"；用客户端工作区服务把 `sessionId → 工作区`；`require('@deepseek-ai/dsh-client-ui-primitives')`；移除目录选择器依赖 |
| `scripts/build.mjs` | 客户端工厂的 externals 白名单加上 primitives |
| `tests/client-card.test.mjs` | 改成"面板"测试：未配置→填链接→写配置；不属于任何工作区→不渲染；认领路径 |
| `tests/host-apply.test.mjs` / `turn-sync.test.mjs` | `areas`→`workspaces`、按会话命中工作区、迁移用例 |
| 新增 `tests/workspaces.test.mjs` | 归属解析三分支（sessionIds / resolveByPath / 导入记账）+ 服务缺失降级 |
| `README.md` / 交互章节 | 重写"界面"与"快速开始"两节；把"两台机器同路径"提到显著位置 |

## 7. 测试计划

- 单元：schema 迁移（旧 `areas` → `workspaces`，高级项保留）；按 cwd 命中/未命中；状态键。
- 客户端：面板开关、输入→写 `workspaces`、`.dsh-sync.json` 认领、无 cwd 不渲染、点外关闭。
- 集成：现有 72 项 + 真后端 E2E 全绿（会话侧不改，应保持全绿）。
- 真机：在 WSL 真实 DSH 上跑一次"打开工作区 → 填远端 → 每轮同步 → 另一份 clone 认领"。
- 双平台：Windows + Linux。

## 8. 分阶段提交

1. **配置模型**：`areas[]`→`workspaces[]` + 迁移 + 主机侧选择逻辑（测试同步改）。
2. **右上角 UI**：按钮 + 面板 + 认领；删卡片；构建白名单。
3. **文档**：README 交互章节 + 本方案归档进 `PLAN-WORKSPACE-SYNC.md`。
4. **验证**：双平台全量 + 真机一轮，然后推送。

## 9. 明确不做的

- 不做"一个仓库装多个工作区的**文件夹内容**"（技术上会互相冲突，见 4.8 的硬约束）。
- 不恢复"选择目录并添加"这类动作 —— 工作区由 DSH 创建，插件只挂同步配置。
- 不改会话归档格式、导入路径、设备提示。
- 暂不动 `ui-workspace` 侧栏（见下条待确认）。
- 暂不做"集中会话仓库"（4.8 的 C 方案），除非你要把它并进 v1。

## 10. 拍板结果

1. **按钮位置**：✅ 会话头部右上角（`conversation.session.header.utilities`，主面板右上角）。
2. **Plugins 卡片**：✅ 保留，改为"兜底入口 + 状态总览"（见 4.7）。
3. **仓库拓扑**：见 **4.8 / 4.9**。修正后的结论：
   - 文件夹**不是**仓库（DSH 资产/笔记）→ 用它自己的仓库，全量同步（**模式 F**）；
   - 文件夹**已经是**你的仓库（项目）→ **插件不碰它**，只把对话送到一个**共享会话仓库**
     （**模式 S**，GitHub 上最多 +1 个仓库，项目仓库的 WIP/分支/历史一律不动）；
   - "每轮自动提交我项目仓库的改动"降级成显式高级选项，且默认不做自动 rebase。
   这是我对你那个问题的答复；**需要你确认模式 S 的"共享会话仓库"要不要进 v1**
   （我认为要 —— 否则你的项目工作区的对话就没地方去了）。

## 11. 调研结论（已全部回来）

- **能用**：`conversation.session.header.utilities`（list、未占满、右对齐、session 作用域，
  `replaceRisk: 'none'`）。新 `id` + `order: 200` 落到最右；**位置只看 `order`，`priority` 不参与横向排序**。
- **不能用**：`header.corner`（single，被 ui-sidebar-right 的 ExpandButton 占住，同 priority 注册会抛）；
  应用外壳/顶栏**没有**可注册 slot（`AppFrame` 里没有 title bar，侧栏 brand 行右侧也没有位置）；
  `ui-workspace` 侧栏那三个图标和每行 `...` 菜单**全是内置组件，没有插槽** ⇒
  "从侧栏给某个工作区配同步"这条入口**不存在**，不做。
- **没有** `workspace/*` 事件；唯一信号是泛化的 `domain/changed`（`change.domain === 'workspace'`），
  本方案不依赖它。
- **卡片保留不需要额外机制**（本来就注册着），只要 Host 侧继续 `installSection` serve 这个命名空间。

1. **面板位置**：我推荐"会话头部右上角"（`conversation.session.header.utilities`，
   就是 `ui-open-in-app` 那个位置，主面板右上角）。如果你说的右上角是**左侧栏「工作区」标题行右边**那三个图标
   附近，那是另一个插槽（全局而非按工作区），我也可以两个都放 —— 你定。
2. **Plugins 卡片**：我倾向**删掉**（配置只从右上角进）。也可以保留成"只读总览"。
3. **一个工作区一个仓库**：按我的理解实现（§2）。如果你其实想"填一次链接，所有工作区都同步到它"，
   告诉我，配置模型会不一样。

## 11b. 已核实完毕（保留结论）

- `ui-workspace` 侧栏**工作区行右侧 `…` 菜单**是否有第三方插槽（有的话可作为第二个入口，
  从侧栏直接给某个工作区配同步）。正在核。

已核实完毕、不再列为待办的两项：
- **没有** `workspace/*` 事件；唯一信号是泛化的 `domain/changed`（`change.domain === 'workspace'`），
  本方案不依赖它（同步由 `turn/end` 驱动，面板由客户端自己的响应式服务驱动）。
- **删掉 Plugins 卡片安全**（见 4.4）。

## 12. 调研给出的三条硬约束（写进实现的自我约束）

1. **宿主里不要碰 `$DSH_HOME/storages/workspace.json`**：无文件监听、内存权威（下次任意写整文件覆盖）、
   schema/version/跨字段不变式写错会让 `dsh-workspace` 整行启动失败。要改工作区只能走 `workspaceRegistry`。
2. **不要把绝对路径或 `WorkspaceId` 写进仓库里的元数据**（`.dsh-sync.json` 已经是机器无关字段，
   保持现状；会话归档以 session id 为主键，也与路径无关）。
3. **不要用 `Workspace.path` 反推会话日志目录**：磁盘上的 `--<projectKey>--` 用的是**原始 cwd**、
   有损（分隔符折叠 + 251 字符截断），与 canonical 路径不是一一映射。
   我们的归档写在**工作区文件夹内部**，本来就不依赖它。

## 13. 实现记录（2026-09）

落地文件：
- `src/host/contract.js`（新增）—— 配置/状态/probe/请求通道四个 schema，双边的唯一契约来源。
- `src/host/workspaces.js`（新增）—— 旧 `areas[]` 迁移、按会话解析工作区、模式判定、按仓库分组、镜像路径。
- `src/host/mirror.js`（新增）—— 镜像复制语义（进：镜像并删除多余；出：只合并不删除；
  时间戳按毫秒比较并显式回写，否则两个平台的重复拷贝结果不一致）。
- `src/host/git.js` —— 新增 `probe()`（只读探测，绝不 init）、`ensureLocalExclude()`
  （写 `.git/info/exclude`，被 `git rev-parse --git-path` 解析，worktree/submodule 都对）、
  提交支持 `commitPaths`（`git commit -- <paths>`，不碰用户已暂存的其它改动）；
  `nestedRepos` 默认改 `refuse`。
- `src/host/index.js` —— 按工作区跑 pass：模式 F 直接 `syncArea`；模式 S 按仓库分组，
  在插件自己的镜像上跑同一套 git 序列，前后各做一次归档复制；探针与状态发布；
  命令通道支持 `probe`/`sync`/`import`（`import` 退役为 probe 的别名）。
- `src/client/index.js` —— 右上角按钮（`id: sync-tool-workspace`，`order: 200`）+ 锚定面板；
  卡片降级为兜底入口与总览。
- `package.json` —— 客户端 `inject` 增加 `@deepseek-ai/dsh-client-ui-workspace`
  （工作区列表就是标准 props 的来源）。

新增/更新的测试：`workspaces.test.mjs`、`mirror.test.mjs`、`mode-sessions.test.mjs`（两种模式的端到端）、
`git-engine.test.mjs`（probe / commitPaths / 私有 exclude / 默认 refuse）、
`client-card.test.mjs`（重写为面板与卡片）、以及既有套件的契约更新。

验证：
- Windows + Linux 全量 **102/102** 通过；真后端 E2E 两平台 **6/6** 通过。
- WSL 里真实 `dsh web`：工作区（一个已有自己仓库与远端的真实项目文件夹）
  在一次 pass 后 **HEAD 完全不变**、项目仓库无新提交、`.dsh-sessions/` 被私有 exclude 隐藏；
  4 条会话归档出现在会话仓库的 `<工作区名>-<hash>/` 下；状态文档 `mode: sessions`、`status: ok`、会话计数递增；
  探针 `kind: repo`、`remote: …/remote.git`（识别出项目自己的远端，但没有拿它当同步目标）。
4. **不要复用别人的 slot id**（`open-in-app`、`session-log-download` 各占一个 id）；
   自己的按钮用新 id，`order: 200`。
5. **不要碰 `header.corner`**：顶掉 ExpandButton 会让用户失去右侧栏开关。
6. **blank 会话看不到按钮**是框架行为（`hideChrome`），不是 bug；兜底是 Plugins 卡片。
7. 字符串：仓库内客户端插件受 `verify-client-ui-i18n` 门禁约束，**仓库外插件扫不到**，
   所以继续用中文字面量是可行的；但 `ui-primitives` 的控件要求必填 label props，
   字面量直接当 label 传即可。（将来想上 i18n 只需 `ctx.locale.register(NS, {zh,en})` + `locale: NS`。）
8. **`ui-primitives` 的 import 要在实机上验一次**：它在 shell 的冻结模块表里
   （`seed.ts:24-39`），按理 bundle 工厂的 `require` 直接可取；
   第一次上页面时先确认这一点，不行就退化成"只用 react + 自渲染 + `--dsw-*` 变量"。
