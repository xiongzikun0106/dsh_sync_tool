# dsh-sync-tool

一个**真实安装的 DeepSeek Harness 插件**（不是对话式动态 Cordis 插件）：用户选择要同步的
「工作区域」，插件在**每轮对话结束后**自动把工作区域同步到用户自己的远程 git 仓库，
用于在不同电脑之间同步 DSH 的插件、预设、技能等工作内容。

- 宿主半边（Host）：注册 `sync-tool` settings 命名空间、工作区域注册表、git 引擎，
  并挂 `turn/end` 钩子。
- 浏览器半边（Client）：设置 → **Plugins** → 「Plugin configuration」标签页中的
  `sync-tool` 卡片，用于选择工作区域、配置远端与查看同步状态。

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
npm test        # 35 个测试：宿主契约 + 真实 git 集成 + 轮次触发 + 便携清单 + 浏览器半边
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
  （slot `settings.plugin.item`、key `sync-tool`、绑定两个命名空间），
  并**真实遍历渲染出的元素树**：空配置、有区域（含状态与历史）、加载中、
  以及没有目录选择器时仍可手动输入；还验证「添加」写 `areas`、「导入」写 `request`。


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
