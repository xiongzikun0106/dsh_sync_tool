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

### 方式 A：作为 bundle 安装（正式路径）

```powershell
dsh plugin --profile web add D:\dsh_sync_tool
# 重启 dsh web，然后刷新页面
```

`dsh plugin` 会把包链接进 profile，并因为 `package.json` 声明了 `dsh.bundle`
而把它追加进 `dsh.profile.bundles`。**新增 bundle 需要重启**：
`dsh.profile.bundles` 只在启动时读取一次。

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

两种方式**不要同时使用**，否则同一行会被挂载两次。

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
- **token 绝不落盘、绝不进 argv**：经 `ctx.credentials` 取值，用 `GIT_ASKPASS`
  临时脚本 + `GIT_TERMINAL_PROMPT=0` 注入；子进程环境会被剥离
  `/KEY|PASSWORD|SECRET|TOKEN/i` 变量，所以必须显式经 `env` 传入。
- **配置走 settings 命名空间**，卡片与 Host 通过命名空间自动配对。
- 客户端 bundle 禁止跨插件值导入，卡片自己渲染自己的控件。
