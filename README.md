# dsh-sync-tool

一个**真实安装的 DeepSeek Harness 插件**（不是对话式动态 Cordis 插件）：用户选择要同步的
「工作区域」，插件在**每轮对话结束后**自动把工作区域同步到用户自己的远程 git 仓库，
用于在不同电脑之间同步 DSH 的插件、预设、技能等工作内容。

- 宿主半边（Host）：注册 `sync-tool` settings 命名空间、工作区域注册表、git 引擎，
  并挂 `turn/end` 钩子。
- 浏览器半边（Client）有**两处**贡献：
  1. 设置 → **Plugins** → 「Plugin configuration」标签页中的 `sync-tool` 卡片，
     用于选择工作区域、配置远端与查看同步状态。
  2. 主面板会话标题栏**右上角**的状态徽标（`conversation.session.header.utilities`），
     一眼可看总体状态，点击展开每个工作区域的状态 / HEAD / 领先落后 / 最近历史 / 失败原因。

### 状态指示器

| 总体状态 | 显示 | 判定 |
|---|---|---|
| 读取中 / 不可用 | 中性灰 | scope 自身还没就绪 |
| 未配置 | 中性灰 | 没有任何工作区域（**中性，不是错误**） |
| 同步中 | 品牌蓝 | `running`，或任一区域 `syncing`/`validating` |
| 冲突 | 警告橙 | 任一区域 `conflict` |
| 错误 | 错误红 | 任一区域 `error` |
| 已同步 / 待同步 | 成功绿 / 中性灰 | 其余情况 |

优先级即上表自上而下；展开面板**始终显示每个区域的真实状态**，所以徽标显示「同步中」时
也不会掩盖底下的冲突或错误。

插槽选择依据（已核实，非杜撰）：

- `conversation.session.header.utilities` 由 `@deepseek-ai/dsh-client-ui-conversation` 声明为
  `{ kind: 'list', scope: 'session' }`，文档描述为
  **"Right-aligned Session utilities in ascending order"**
  （`packages/client/ui-conversation/src/client/contract/slots.ts:139`），正是要的右上角位置。
- 紧邻的 `conversation.session.header.corner` 是 `kind: 'single'`，且**已被**
  `ui-sidebar-right` 的展开按钮占用，无法追加；list 座位是唯一可加的。
- 因此 `package.json` 的 `dsh.client.inject` 补上了 `@deepseek-ai/dsh-client-ui-conversation`。
- **没有**一个 root 作用域的「主面板右上角」座位：`shell.overlay` 是 root 作用域的浮动层，
  文档明确欢迎「badge / status pill」，但它覆盖整帧、需要自己 fixed 定位，会与会话标题栏
  自己的右上角控件（utilities / corner）打架。所以选了会话作用域的 `utilities`。
  代价：**空白/英雄页（没有会话时）不显示该徽标**。

完整设计（含已验证的机制与证据）见 [`PLAN.md`](./PLAN.md)。

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 包骨架 + bundle 行 + 客户端卡片 + 构建 + 安装验证 | ✅ 完成 |
| P1 | settings 命名空间 + 工作区域 CRUD + 目录选择 + 宿主状态发布 | ✅ 完成 |
| P2 | git 引擎（`ctx.subprocess`）+ 手动同步 + 状态与历史 | ✅ 完成 |
| P3 | `turn/end` 自动同步 + 防抖单飞队列 + 冲突停靠 | ✅ 完成 |
| P4 | 跨机验证 + 便携清单 `.dsh-sync.json` + 最终文档 | ✅ 完成 |

## 测试

```sh
npm test        # 40 个测试：宿主契约 + 真实 git 集成 + 轮次触发 + 便携清单 + 浏览器半边
```

- `tests/host-apply.test.mjs` 钉住宿主契约：命名空间用 `installSection` 注册、
  状态命名空间是宿主全量发布、`session/event` 钩子挂在 fiber 上、
  没有 settings provider 时依然可加载。
- `tests/git-engine.test.mjs` 用真实 git 和真实 bare 仓库当远端，覆盖：首次初始化并推送、
  无变更空跑、分叉后 rebase 并推送、**真冲突时停住且工作区未被破坏**、敏感文件拒提交、
  父仓库内建独立仓库 / 配置为拒绝、push-only 与 pull-only 的单向语义、未配置远端。
- `tests/turn-sync.test.mjs` 驱动真实的 `turn/end` 监听器：区域内的一轮触发同步并真的推送到
  远端；区域外的一轮被忽略；`syncAllOnTurnEnd` 让无关轮次也同步；连发 4 次轮次边界**合并为一次**
  同步；`syncOnTurnEnd: false` 关闭；失败不会从监听器抛出且 `running` 标志被清回 false。
- `tests/portable.test.mjs` 便携清单往返：**路径 / id / 凭据引用 / 启用位永不进入清单**，
  导入时在本机重新决定；机器本地变化不会让清单产生噪声提交。
- `tests/client-card.test.mjs` 把 `lib/client.js` 按浏览器模块表的方式加载
  （假 `window.__ModuleLoader__` + 假 `require('react')`），断言注册契约
  （slot `settings.plugin.item` 用 `key`、slot `conversation.session.header.utilities`
  用 `id` + `order`、绑定两个命名空间），
  并**真实遍历渲染出的元素树**：
  - 卡片：空配置、有区域（含状态与历史）、加载中、没有目录选择器时仍可手动输入；
    「添加」写 `areas`、「导入」写 `request`。
  - 指示器：八种总体状态各自的文案；并用**带状态的假 React 真的点击徽标**，
    验证展开后出现区域名（来自 config scope）、HEAD、↑/↓、失败原因与历史，
    再点「收起」确认收起；另验证无区域时面板指向卡片、无历史时不渲染历史小节。


> 测试进程设置 `GIT_CEILING_DIRECTORIES`：本机 `C:\Users\xiongyb\.git` 存在，
> 即**家目录本身是一个 git 仓库**，否则临时目录会被误判为「位于父仓库内部」。

## 跨电脑使用

每个被同步的仓库根会写入 `.dsh-sync.json`（**只含机器无关字段**：名称、远端、分支、方向、
自动提交、敏感文件保护、父仓库策略、附加忽略）。它随提交一起进入远端，于是另一台机器可以：

1. `git clone <远端> <目标目录>`
2. 安装本插件（见上）
3. 设置 → Plugins → Plugin configuration → `sync-tool` 卡片 → **从仓库导入**，
   选择该目录：宿主读取清单、在本机生成新的区域（本机路径、新 id、空凭据引用），
   远端与分支沿用清单。

这样「插件源码 + 预设 + 技能」都随同一个仓库在两台机器间流动。


## 每轮对话触发

`ctx.on('session/event')` 里只看 `event.type === 'turn/end'`（所有退出路径都会发出，含抛错）。
`session/event` 监听器是**提交后、fire-and-forget、异常被吞**的，所以同步再慢也不会拖慢或
破坏对话。

- 默认只同步**包含该会话工作目录**（`session.header.cwd`）的区域；
  勾选「每轮同步全部区域」则每轮同步全部启用的区域。
- 防抖窗口内的多次轮次边界**合并成一次** pass（`debounceMs`，默认 5s）。
- 全局**单飞**：同一时刻只有一个 git 序列在跑，其余排队。
- 插件卸载时清掉待触发定时器并等待在途 pass 收尾。

### 已知边界：一次性任务模式

`dsh --profile headless "<task>"` 这类**一次任务就退进程**的用法下，`turn/end` 之后
启动的同步会被进程拆除腰斩：宿主拆掉 `subprocess` / `settings` 时 pass 还没跑完
（在 Linux 上实测表现为远端收不到提交、状态停在 `running: true`、只写下了
`.dsh-sync.json`）。

根因是宿主里唯一**被 await** 的轮次收尾钩子 `agent/turn-stopping` 只在轮次
**成功收尾**时触发（`packages/core/agent-loop/src/agent.ts:315-318`，位于 `try` 内），
出错轮次走 `catch` 直接跳过；而 `turn/end` 虽然所有路径都会发，却是
fire-and-forget，拦不住进程退出。

**持续会话（Web GUI、交互式会话）不受影响**：轮次之间进程一直活着，
防抖窗口结束后 pass 正常跑完。一次性模式属于已知边界，**未修**。


## 同步引擎行为

每个工作区域一次同步依次执行：识别仓库 → 对齐 `origin` → 提交本地变更 →
拉取并整合 → 推送。

- **空远端是正常起点**：`git fetch --prune origin`（不是取单个 refspec，否则首次推送会因
  `couldn't find remote ref` 直接失败）。
- **整合策略**：仅远端领先 → `merge --ff-only`；双方都领先 → `pull --rebase --autostash`。
- **冲突即停**：rebase 失败一律 `git rebase --abort` 复原，状态置为 `conflict`，
  **绝不自动解决冲突**，也绝不把半完成的 rebase 留给用户。
- **父仓库内的目录**：默认在该目录内初始化**独立嵌套仓库**
  （家目录是仓库时 `$DSH_HOME` 下的资产正属此列）；可在区域选项里改为拒绝。
- **敏感文件保护**：暂存区出现 `.credentials.yaml`、`.env`、`.netrc`、`settings.yaml`、
  私钥时拒绝自动提交，且不推送任何东西。
- **凭据**：token 经 `ctx.credentials` 读取，以 `GIT_CONFIG_COUNT/KEY_0/VALUE_0` 环境变量
  注入 `http.extraheader`（git 2.31+），**不进 argv、不落盘**；输出里的 token 会被替换为 `***`。
- 新建目录会自动写入一份 `.gitignore`（`node_modules/`、`lib/`、`dist/`、`*.log`、
  `.credentials.yaml`、`settings.yaml`）。
- **提交身份**：先用机器自身的 git 身份提交；只有当 git 因**没有身份**而拒绝
  （`Author identity unknown` 等）时，才用配置的 `commitIdentity`，或派生的
  `dsh-sync@<hostname>`，**重试一次**，并在状态详情里**明示**用了回退身份
  （例：`已提交（回退身份 dsh-sync，本机未配置 git 身份）`）。
  **真实的机器身份永远不会被覆盖。** 这条是 Linux 上真实验证时发现的：
  跨机流程的「第二台机器」通常就是没配过 git 身份的新机器，
  没有回退时它的第一次自动同步必然以 `Author identity unknown` 失败。


## 构建

```sh
npm run build     # 生成 lib/index.js 与 lib/client.js
npm test          # 宿主半边契约测试
```

`lib/client.js` 由 `scripts/build.mjs` 包装成客户端模块表要求的惰性 CJS 闭包工厂
（`window.__ModuleLoader__.load({ id, factory })`）。仓库外的包没有可用的
`clientBundle` 预设，所以这里复刻了该格式。

**浏览器半边保持单文件**（`src/client/index.js`），两个贡献（卡片 + 状态指示器）都在其中。
判断依据：包装器只允许**一层** `window.__ModuleLoader__.load(...)`，所以拆成多个文件就需要
在构建脚本里再做一层模块拼接——那正是最容易出错的地方（`require` 注入、相对导入解析、
`unwrapExports` 语义）。单文件让 `scripts/build.mjs` 保持"原样包一层"这么简单，风险最低。
`tests/client-card.test.mjs` 里的辅助函数也依赖这一点。

### 本地开发依赖

宿主半边 `import z from '@deepseek-ai/schemastery'`。包被 `link:` 进 profile 后，
Node 会按真实路径解析依赖，因此本仓库需要一个 `node_modules/@deepseek-ai/schemastery`：

```powershell
New-Item -ItemType Directory -Force node_modules\@deepseek-ai | Out-Null
New-Item -ItemType Junction `
  -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:DSH_HOME\profiles\node_modules\@deepseek-ai\schemastery"
```

（`node_modules/` 已 gitignore。发布到 npm 时该依赖按 `package.json` 正常安装。）

## 安装

**先记住一条前提**：本包在运行时 `import` 了 `@deepseek-ai/schemastery`（`package.json` 的
`dependencies`）。**pnpm 的 `link:` 不会安装被链接包的依赖**——所以「用目录路径直接 add」
在干净机器上会以 `ERR_MODULE_NOT_FOUND` 失败。下面两条路各自怎么处理这一点，是本节重点。

### 方式 A：正式安装（装得上依赖，需要重启）

用 `file:` 明确告诉 pnpm 这是一个要**复制并解析依赖**的包（用 tarball `npm pack` 的产物
或已发布到 registry 的包名同样可以）：

```powershell
dsh plugin --profile web add file:D:/dsh_sync_tool
# 然后重启 dsh web，再刷新页面
```

已实测：`file:` 会把包**复制**成真实目录放进
`$DSH_HOME/profiles/<profile>/node_modules/dsh-sync-tool`，并把
`@deepseek-ai/schemastery` hoist 到 profile 的 `node_modules`，于是包内
`import '@deepseek-ai/schemastery'` 能解析——**真实 DSH 启动可挂载**
（实测日志：`[sync-tool] host half loaded`）。

代价：`file:` 是**复制**，改完源码要重新 `add` 一次；且包会因
`dsh.bundle` 被追加进 `dsh.profile.bundles`，而 **`bundles` 只在启动时读一次 → 必须重启**。

> 用**目录路径**而不是 `file:`（即 pnpm 的 `link:`）会得到
> `"dsh-sync-tool": "link:..."`：包目录被符号链接，**它自己的依赖不会被安装**，
> 宿主半边加载即失败。只有在你已经按「本地开发依赖」一节手工提供该依赖时，
> `link:` 才可用。

### 方式 B：活补丁挂载（开发路径，无需重启）

profile 的 `cordis.patch.yml` 是**热监听**的，所以把行写进该文件即可即时挂载：

```yaml
- insert:
    - id: sync-tool
      name: dsh-sync-tool
      config: {}
```

配合只装依赖、不动 `bundles`：

```powershell
cd $env:DSH_HOME\profiles\web
pnpm add "link:D:/dsh_sync_tool"
```

**这条路径要求你自己提供插件的运行时依赖**（见上面「本地开发依赖」一节的 junction），
因为 `link:` 不会装它。

### 两种方式不要混用

方式 B 的行写在 profile 的 `cordis.patch.yml` 里，方式 A 的行来自包自带的
`cordis.patch.yml`（经 `dsh.profile.bundles`）。**同时使用会让同一行被挂载两次**。
本机当前用的是**方式 B**（`bundles` 里没有 `dsh-sync-tool`，行在 `cordis.patch.yml`）。

### 本包 `files` 白名单的硬要求

`package.json` 的 `files` 必须覆盖**全部宿主产物**。当前是：

```json
"files": ["lib/*.js", "cordis.patch.yml"]
```

这是被真实缺陷逼出来的：早先写作 `["lib/index.js", "lib/client.js", "cordis.patch.yml"]`，
漏掉了 P2/P3 新增的 `lib/git.js` 与 `lib/portable.js`。因为 `link:` 用的是完整源码树，
本机与 WSL 长期都没暴露；直到按 `file:` 安装才失败于
`Cannot find module '.../lib/git.js' imported from '.../lib/index.js'`。
**任何新增宿主模块都必须落在 `lib/*.js` 覆盖范围内。**

## 检查安装是否成功

```powershell
# 1) profile 里装了什么
Get-Content $env:DSH_HOME\profiles\web\package.json
#    方式 A：dependencies 形如 "file:D:/dsh_sync_tool"，且 bundles 含 dsh-sync-tool
#    方式 B：dependencies 形如 "link:D:/dsh_sync_tool"，且 bundles 不含它

# 2) 合成出来的行
cd D:\deepseek-harness-master
pnpm dsh --profile web --dump-config    # 应出现名称为 dsh-sync-tool 的 sync-tool 行
```

启动后应看到一行日志：`[sync-tool] host half loaded (namespaces "sync-tool", "sync-tool-status")`。

## 验证

```powershell
cd D:\deepseek-harness-master
pnpm dsh --profile web --dump-config    # 应出现 "# == ...profiles\web\cordis.patch.yml" 下的 sync-tool 行
```

浏览器侧：`GET /` 的 `__DSH_BOOT__` 图应包含 `dsh-sync-tool` 条目，
且 `/plugins/??dsh-sync-tool/client.js&rev=<rev>` 返回 200。
**新增客户端行必须刷新页面**——浏览器会忽略 `graph` 帧，只热换已知 id。

## 设计约束（已核实，务必遵守）

- **git 走 `ctx.subprocess`，不走 `ctx.shell`**：`ctx.shell` 会被沙箱化执行器包装，
  默认 `workspace-write` 下会拒绝写入会话工作区之外的目录，而 `turn/end` 钩子
  **无法申请审批**（审批要求存在打开的轮次）。
- **token 绝不落盘、绝不进 argv**：经 `ctx.credentials` 取值，用 `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` 注入 `http.extraheader`（git 2.31+ 读取环境中的
  git 配置），配合 `GIT_TERMINAL_PROMPT=0`。子进程环境会被剥离
  `/KEY|PASSWORD|SECRET|TOKEN/i` 变量，所以必须显式经 `env` 传入；输出里的 token 与其
  base64 形式都会被替换为 `***`。（**不是** `GIT_ASKPASS` 临时脚本。）
- **配置走 settings 命名空间**，卡片与 Host 通过命名空间自动配对。
- 客户端 bundle 禁止跨插件值导入，卡片自己渲染自己的控件。

## 验证记录

| 环境 | 验证到什么 |
|---|---|
| **Windows 10/11 + Node 24** | 42/42 测试；实时 GUI 的 `__DSH_BOOT__` 含 `dsh-sync-tool` 且 `/plugins/??…/client.js` 200；`--dump-config` 行合成正确；**真实运行时**经命令通道端到端推送成功（`29bcb36 dsh-sync: xiongyb … (turn 0)`） |
| **Debian 13 (WSL1) + Node 22** | 42/42 测试（含平台相关的 `normalizePath` / `pathContains`）；**无头 profile 挂载**（`[sync-tool] host half loaded`，无 web 栈、无浏览器半边）⇒ 宿主半边不依赖 GUI；**行 config 配置工作区域**可用；长驻 `dsh web` 下**真实推送到 bare 远端**（`2033ba8`）；**跨机导入**：克隆到 machineB 后经命令通道导入，新区域 `credentialRef` 为空、远端沿用清单 |
| **交付物自足性** | 从 `HEAD` 全新克隆（16 个文件）+ 按 README 提供唯一运行时依赖 → 构建成功、42/42 通过 |

**尚未验证（明确列出，不当作已验证）**

- 用**真实 LLM 对话轮次**驱动 `turn/end` 触发同步 —— 需要 API key，未使用；
  `turn/end` 的逻辑由测试套件（真实监听器 + 真实 git）覆盖。
- **需要认证的 HTTPS 推送** —— 没有可用的 HTTPS 远端；只单独验证了环境变量注入
  这条机制本身可用。
- 卡片与状态指示器在**真实浏览器里的视觉呈现** —— 元素树与注册契约已验证，但没有浏览器。
- **一次性任务模式**下的同步 —— 已知边界，见上。
- 在**真实独立服务器**上运行 —— 目标 VPS 在这条网络路径上 22 端口被整体阻断
  （三个无关境外主机同样被 RST，与那台机器无关），故改用本地 WSL。
