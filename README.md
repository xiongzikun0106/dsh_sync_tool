# dsh-sync-tool

**把你选定的文件夹，在每轮对话结束后自动同步到你自己的远程 git 仓库。**

用来在不同电脑之间搬运 DeepSeek Harness 的插件、预设、技能等工作内容：
在这台机器上改完，另一台 `git clone` 一下就能接着用。

- **它不注册任何模型工具** —— 对话里不会出现它，也不占 token、不改你的提示词。
- 两个界面：**设置页的配置卡片**（选目录、填远端）+ **会话头部右上角的状态按钮**（看同步情况）。
- 冲突**绝不自动解决**：一旦真冲突就原样停住并告警，不动你的文件。

---

## 目录

- [它做什么 / 不做什么](#它做什么--不做什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [首次使用](#首次使用)
- [界面在哪](#界面在哪)
- [跨电脑使用](#跨电脑使用)
- [配置参考](#配置参考)
- [同步是怎么做的](#同步是怎么做的)
- [排障](#排障)
- [已知边界](#已知边界)
- [开发](#开发)
- [验证状态](#验证状态)

---

## 它做什么 / 不做什么

**做**

每轮对话结束（`turn/end`）后，把「包含当前会话工作目录」的工作区域自动提交并同步到远端。
也可以手动点「立即同步」，或让它在启动时同步一次。

同步一个区域时的动作：识别仓库 → 对齐 `origin` → 提交本地变更 → 拉取并整合 → 推送。
每个被同步的仓库根会写入一份 `.dsh-sync.json`，让**另一台机器可以一键接管**这个目录。

**不做**

| 不做的事 | 说明 |
|---|---|
| 注册模型工具 / 影响对话 | 宿主半边不注册任何工具，不进提示词、不占 token |
| 自动解决冲突 | 真冲突就 `rebase --abort` 停住，保留你的文件原样，状态报 `conflict` |
| 替你创建远端仓库 | 远端要你自己先建好（GitHub / GitLab / Gitea / 自建 / 本机 bare 仓库都行） |
| 同步 `node_modules`、构建产物、凭据 | 见[忽略与敏感文件](#忽略与敏感文件) |
| 做通用备份 | 它是 git 同步，不是快照工具；历史由你的 git 仓库负责 |

---

## 环境要求

| 需要 | 说明 |
|---|---|
| DSH | `dsh` 命令可用（本插件装进某个 profile） |
| git | ≥ 2.26（环境变量注入 git 配置需要 2.31+，本插件用它传凭据） |
| Node | 跟随 DSH 自身要求：`^22.19` 或 `>=24` |
| 一个 git 远端 | 你自己的仓库，或本机一个 `git init --bare` 目录 |

一个真实坑：**WSL1 上 Node 24 跑不起来**（`Exec format error`），Node 22 可以。
如果你在 WSL1 里试，装 22。

---

## 安装

### 先理解一个前提：`link:` 不会安装插件的依赖

本包运行时 `import` 了 `@deepseek-ai/schemastery`（在 `package.json` 的 `dependencies` 里）。
而 pnpm 的 **`link:`（也就是「直接给一个目录路径」）不会安装被链接包的依赖**。
所以「用目录路径直接 add」在干净机器上会以 `ERR_MODULE_NOT_FOUND` 失败——宿主半边加载不起来。

下面两条路各自怎么处理这一点，是本节的重点。

### 方式 A：正式安装（推荐）

用 `file:` 明确告诉 pnpm「这是一个要复制并解析依赖的包」：

```powershell
dsh plugin --profile web add file:D:/dsh_sync_tool
# 然后重启 dsh web，再刷新页面
```

- pnpm 会把包**复制**成真实目录放进 `$DSH_HOME/profiles/web/node_modules/dsh-sync-tool`，
  并把 `@deepseek-ai/schemastery` 装到 profile 的 `node_modules`，于是包内 `import` 能解析。
- 因为包声明了 `dsh.bundle`，它会被追加进 `dsh.profile.bundles` ——
  而 **`bundles` 只在启动时读一次，所以必须重启**。
- 代价：`file:` 是**复制**，改完本插件源码要重新 `add` 一次。

用 tarball（`npm pack` 的产物）或已发布到 registry 的包名，机制相同。
> 只实测过 `file:` 与 `link:`，tarball / registry 安装没有实测。

### 方式 B：开发安装（改代码即时生效）

profile 的 `cordis.patch.yml` 是**热监听**的，把行直接写进去就能立刻挂载：

```yaml
- insert:
    - id: sync-tool
      name: dsh-sync-tool
      config: {}
```

再只装依赖、不动 `bundles`：

```powershell
cd $env:DSH_HOME\profiles\web
pnpm add "link:D:/dsh_sync_tool"
```

**这条路径要你自己提供插件的运行时依赖**（因为 `link:` 不装它）：

```powershell
cd D:\dsh_sync_tool
New-Item -ItemType Directory -Force node_modules\@deepseek-ai | Out-Null
New-Item -ItemType Junction `
  -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:DSH_HOME\profiles\node_modules\@deepseek-ai\schemastery"
```

好处：改插件源码**不用重启**，只需刷新页面。

### 两种方式不要混用

方式 B 的行写在 profile 的 `cordis.patch.yml` 里；方式 A 的行来自包自带的
`cordis.patch.yml`（经 `dsh.profile.bundles`）。**同时使用会让同一行被挂载两次。**

判断当前用的是哪种：

```powershell
Get-Content $env:DSH_HOME\profiles\web\package.json
# 方式 A：dependencies 形如 "file:D:/dsh_sync_tool"，且 bundles 里含 dsh-sync-tool
# 方式 B：dependencies 形如 "link:D:/dsh_sync_tool"，且 bundles 里不含它
```

### 无 GUI / 服务器上怎么配

服务器上没有浏览器，也就没有卡片。用**组合行自己的 `config`** ——
它会作为 composition base 层垫在用户文档之下，所以照样生效：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: sync-tool
  config:
    enabled: true
    syncOnTurnEnd: true
    areas:
      - id: my-plugins
        path: /home/me/dsh-plugins
        remote: git@github.com:me/dsh-sync.git
        branch: main
```

（也可以直接编辑 `$DSH_HOME/settings.yaml`，但手写 YAML 不如上面这种。）

---

## 首次使用

1. 启动 DSH。终端里应出现这一行，说明宿主半边挂上了：

   ```
   [sync-tool] host half loaded (namespaces "sync-tool", "sync-tool-status")
   ```

2. 打开 GUI → **设置 → Plugins → Plugin configuration**，找到 **「工作区域 Git 同步」** 卡片。
3. 点 **「选择目录并添加」** → 弹出系统目录选择器，选你要同步的文件夹。
   （选择器不可用时，下面还有输入框可以手填绝对路径；也可以点 **「+ 预设目录」**
   一键加入 `$DSH_HOME/.agent-presets`。）
4. 在区域行里填 **远端**（例如 `https://github.com/you/dsh-sync.git`）和 **分支**。
   用私有仓库就填 **凭据**（凭据名的引用，见[凭据](#凭据)）；公开仓库留空即可。
5. 点 **「立即同步全部」**。状态会从「同步中」变成「已同步」，下面是它报的 HEAD 与领先/落后。
   首次同步会自动 `git init`、写入 `.gitignore`、提交、并推送到你的远端。

之后每轮对话结束都会自动同步。任何时候想看情况，点会话头部右上角的状态按钮。

---

## 界面在哪

| 界面 | 位置 | 能做什么 |
|---|---|---|
| **配置卡片** | 设置 → Plugins → Plugin configuration → 「工作区域 Git 同步」 | 增删工作区域、改名称/远端/分支/凭据/方向/选项、立即同步、从仓库导入、启用总开关、看状态与历史 |
| **状态按钮** | **会话头部右上角**（右对齐工具区） | 一眼看总体状态（同步中 / 已同步 / 冲突 / 错误 / 未配置），点开看每个区域的名称、路径、HEAD、领先/落后、失败原因与最近历史 |

> 新增的客户端界面**需要刷新页面**才出现 —— 浏览器会忽略启动图的新增行，只热换已知的行。

---

## 跨电脑使用

**机器 A（先配好的那台）**

1. 按[安装](#安装)装好，按[首次使用](#首次使用)配好工作区域并同步成功。
2. 每个被同步的仓库根会写入 `.dsh-sync.json`，随提交一起进远端。

**机器 B（另一台）**

1. `git clone <远端> <目标目录>`
2. 同样装好本插件。
3. 设置 → Plugins → Plugin configuration → **「从仓库导入」** → 选中刚 clone 的目录。
   宿主会读取 `.dsh-sync.json`，在本机生成一个新的工作区域：
   **路径是本机的、id 是新的、凭据引用为空**，远端与分支沿用清单。

`.dsh-sync.json` 里**只放机器无关的字段**（名称、远端、分支、方向、自动提交、
敏感文件保护、父仓库策略、附加忽略）。**绝对路径、区域 id、启用位、凭据引用永不出本机。**

---

## 配置参考

### 顶层

| 字段 | 默认 | 作用 | 卡片里能改 |
|---|---|---|---|
| `enabled` | `true` | 总开关，关掉后不做任何自动同步 | ✅ |
| `syncOnTurnEnd` | `true` | 每轮对话结束后同步 | ✅ |
| `syncOnStartup` | `false` | 宿主启动时同步一次 | ✅ |
| `syncAllOnTurnEnd` | `false` | 每轮同步**全部**启用区域（默认只同步包含当前会话工作目录的那些） | ✅ |
| `debounceMs` | `5000` | 防抖窗口；窗口内多次轮次边界合并成一次 | ✅ |
| `areas` | `[]` | 工作区域列表 | ✅ |
| `commitMessageTemplate` | `dsh-sync: {host} {time} (turn {turn})` | 提交信息模板，支持 `{host}` `{time}` `{turn}` | ❌ 只能写配置 |
| `historyLimit` | `20` | 状态里保留多少条历史 | ❌ 只能写配置 |
| `commitIdentity` | `{ name: '', email: '' }` | 本机没有 git 身份时用谁提交（见[提交身份](#提交身份)） | ❌ 只能写配置 |

### 单个工作区域

| 字段 | 默认 | 作用 | 卡片里能改 |
|---|---|---|---|
| `id` | 必填 | 稳定标识，由卡片生成 | 自动 |
| `path` | 必填 | 绝对路径 | 添加时选 |
| `name` | `''` | 显示名 | ✅ |
| `remote` | `''` | 远端 URL；留空则只做本地提交 | ✅ |
| `branch` | `main` | 跟踪的分支 | ✅ |
| `credentialRef` | `''` | 凭据名引用；留空则用系统 git 凭据 | ✅ |
| `direction` | `both` | `both` 先拉再推 / `push` 只推 / `pull` 只拉 | ✅ |
| `enabled` | `true` | 是否参与自动同步 | ✅ |
| `autoCommit` | `true` | 同步前自动提交本地变更 | ✅ |
| `guardSensitive` | `true` | 暂存区出现敏感文件时拒绝提交 | ✅ |
| `nestedRepos` | `init` | 目录位于另一个仓库内部时：`init` 在里面建独立仓库 / `refuse` 拒绝操作 | ✅ |
| `extraIgnores` | `[]` | 追加到 `.gitignore` 的忽略规则 | ❌ 只能写配置 |

---

## 同步是怎么做的

### 一次同步的步骤

1. **识别仓库**。不是仓库就 `git init`；位于**另一个仓库内部**时按 `nestedRepos` 决定：
   默认在该目录里建**独立嵌套仓库**，也可以配置为拒绝。
2. **对齐 `origin`**。按配置的 `remote` 添加或改写 `origin`。
3. **提交本地变更**。有变更才提交；提交前先确保 `.gitignore` 含内置规则与 `extraIgnores`。
4. **拉取并整合**。`git fetch --prune origin`（取全部 refs ——
   单个 refspec 在远端尚无该分支时是致命错误，而空远端是正常起点）。
   然后：仅远端领先 → `merge --ff-only`；双方都领先 → `pull --rebase --autostash`。
5. **推送**。`git push -u origin <branch>`。
6. **报告**。HEAD 与领先/落后是**推送之后**重读的，所以刚推完不会谎报「领先」。

### 冲突怎么办

真冲突（双方改了同一处）时：`git rebase --abort` 复原 → 状态置为 `conflict` →
详情里带上 git 的原始报错。**你的文件保持原样，绝不自动合并。**
之后每次触发都会重新尝试；冲突仍在就再次停在 `conflict`。

### 忽略与敏感文件

自动写入/补齐 `.gitignore`（已存在的内容不动，只追加缺的行，重复规则不会重复写）：

```
node_modules/    lib/    dist/    *.log    .credentials.yaml    settings.yaml
```

提交前会扫描暂存区，命中这些**一律拒绝提交并告警**（`guardSensitive` 默认开）：

```
.credentials.yaml / .credentials.yml
.env / .env.*
.netrc
settings.yaml / settings.yml
id_rsa / id_ed25519 / id_ecdsa / id_dsa
```

### 提交身份

先用**机器自身的 git 身份**提交。只有当 git 因**没有身份**而拒绝
（`Author identity unknown`）时，才用配置的 `commitIdentity`，或派生的
`dsh-sync@<hostname>`，**重试一次**，并在状态详情里明示，例如：

```
已提交（回退身份 dsh-sync，本机未配置 git 身份） · 已同步
```

**真实的机器身份永远不会被覆盖。** 想让这台机器的同步提交署你的名，就配：

```yaml
commitIdentity:
  name: Your Name
  email: you@example.com
```

（跨机流程里「第二台机器」常常是没配过 git 身份的新机器——这正是为它准备的。）

### 凭据

`credentialRef` 是**凭据名**，不是密码本身。取值走 DSH 的 `ctx.credentials`，
以环境变量注入的 git 配置形式传给子进程（`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` /
`GIT_CONFIG_VALUE_0` → `http.extraheader`），配合 `GIT_TERMINAL_PROMPT=0`：

- **不进命令行参数、不写进 `.git/config`、不落盘**；
- 输出里出现的 token 与其 base64 形式都会被替换成 `***`；
- 用户名固定用 `oauth2`，密码是你的 token（GitHub / GitLab / Gitea 都接受这种形式）。

所以本机没配 git 凭据也没关系：把 token 存进 DSH 的凭据库，卡片里填那个名字即可。

---

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡片 / 右上角按钮不出现 | 宿主行没挂上，或页面没刷新 | 查 `dsh --profile web --dump-config` 里有没有 `name: dsh-sync-tool` 的行；查启动日志有没有 `host half loaded`；**刷新页面** |
| `ERR_MODULE_NOT_FOUND: '@deepseek-ai/schemastery'` | 用了 `link:` 而没提供依赖 | 改用 `file:` 安装（方式 A），或按方式 B 建那个 junction |
| `Cannot find module '.../lib/git.js'` | 包被 `files` 白名单截断 | 本包已修为 `"files": ["lib/*.js", "cordis.patch.yml"]`；你若改过结构，确保所有 `lib/*.js` 都在白名单里 |
| 状态一直是「同步中」不动 | 进程在 pass 中途退出（一次性任务模式，见[已知边界](#已知边界)） | 持续会话不受影响；一次性任务会这样 |
| 状态显示「不可用」 | 状态命名空间没被服务 | 宿主半边没加载，查上面第一条 |
| 某个区域一直是 `error` | 目录不存在 / 非绝对路径 / git 报错 | 卡片里看该区域的 `detail`，它就是原因；git 的原始 stderr 也在里面 |
| `git push 失败` | 远端地址、网络、或凭据问题 | 详情里有 git 原始 stderr；确认远端可达、凭据名有效 |
| 「该目录位于另一个 git 仓库内部」 | 目标目录在别的仓库里（**家目录本身是仓库**时很常见） | 默认会建独立嵌套仓库；想拒绝就把该区域的「父仓库内建库」关掉 |
| 同一行被挂载了两次 | 安装方式 A 与 B 混用 | 只留一种（见[两种方式不要混用](#两种方式不要混用)） |
| 改了宿主代码不生效 | 加载器 import 没有缓存失效机制 | **宿主代码改动必须重启 `dsh web`**；客户端 bundle 会自动热换 |
| SSH 远端连不上 | 部分网络会阻断出境的 22 端口（与服务器无关） | 用 **HTTPS 远端** —— 也正好是上面那条凭据路径 |

---

## 已知边界

- **一次性任务模式**：`dsh --profile headless "<task>"` 这种「跑完就退进程」的用法下，
  `turn/end` 之后启动的同步会被进程拆除腰斩（远端收不到提交，状态停在 `running: true`，
  只会写下 `.dsh-sync.json`）。
  根因：宿主里唯一**被 await** 的轮次收尾钩子 `agent/turn-stopping` 只在轮次**成功收尾**时
  触发（`packages/core/agent-loop/src/agent.ts:315-318` 在 `try` 内），出错轮次走 `catch` 跳过；
  而 `turn/end` 虽然是所有路径都会发，却是 fire-and-forget，拦不住进程退出。
  **持续会话（Web GUI、交互式会话）不受影响。** 这个边界没有修。
- **宿主代码改动需要重启**（加载器不 bust ESM 缓存）；客户端 bundle 会热换，新客户端行需要刷新页面。
- **新增 bundle 需要重启** profile：`dsh.profile.bundles` 只在启动时读一次。
- 本包**未在真实独立服务器上验证过**（只在 Windows 与本地 WSL Debian 上验证）。

---

## 开发

```sh
npm run build     # 生成 lib/*.js（宿主）与 lib/client.js（浏览器半边）
npm test          # 43 个测试
```

### 目录结构

```
package.json           # dsh.bundle（profile 层）+ dsh.client（浏览器半边）+ files 白名单
cordis.patch.yml       # 作为 bundle 时插入的宿主行
scripts/build.mjs      # 构建：拷贝 src/host/*.js，并把 src/client/index.js 包成 CJS 工厂
src/host/index.js      # 插件入口：两个 settings 命名空间、命令通道、turn/end 钩子、队列
src/host/git.js        # git 引擎：一次同步的完整序列、凭据注入、忽略与敏感文件
src/host/portable.js   # .dsh-sync.json 便携清单的读写
src/client/index.js    # 浏览器半边（单文件）：配置卡片 + 会话头部状态按钮
tests/                 # 宿主契约 + 真实 git 集成 + 轮次触发 + 便携清单 + 浏览器半边
```

### 为什么浏览器半边要手写包装

客户端 bundle 必须是**惰性 CJS 闭包工厂**：

```js
window.__ModuleLoader__.load({ id: "...", factory: (require) => { ... } })
```

monorepo 里那个 `clientBundle` tsdown 预设**没有发布**，仓库外的包拿不到，
所以 `scripts/build.mjs` 自己复刻了这个格式（banner / footer / intro / `format: cjs`）。
React 由工厂注入的 `require('react')` 提供。

另外：客户端 bundle **禁止跨插件值导入**（纯净度门禁），所以两个界面都自己渲染自己的控件，
只通过 Cordis 服务协作（`ctx.slots` / `ctx.settingsScope` / `ctx.remote`）。

### 本地开发依赖

宿主半边 `import z from '@deepseek-ai/schemastery'`。包被 `link:` 进 profile 后，
Node 按**真实路径**解析依赖，所以本仓库需要一个
`node_modules/@deepseek-ai/schemastery`（做法见方式 B）。`node_modules/` 已 gitignore。

### 打包的硬要求

`files` 必须覆盖**全部宿主产物**，当前是 `["lib/*.js", "cordis.patch.yml"]`。

这是被真实缺陷逼出来的：早先写作 `["lib/index.js", "lib/client.js", "cordis.patch.yml"]`，
漏掉了后来新增的 `lib/git.js` 与 `lib/portable.js`。因为开发期一直用 `link:`（指向完整源码树），
问题长期没暴露；直到按 `file:` 安装才失败于
`Cannot find module '.../lib/git.js' imported from '.../lib/index.js'`。
**任何新增的宿主模块都必须落在 `lib/*.js` 覆盖范围内。**

### 测试覆盖

| 文件 | 覆盖 |
|---|---|
| `tests/host-apply.test.mjs` | 命名空间用 `installSection` 注册、状态命名空间由宿主全量发布、`session/event` 钩子挂在 fiber 上、没有 settings provider 时仍可加载 |
| `tests/git-engine.test.mjs` | 真实 git + 真实 bare 仓库：首次推送、空跑、分叉后 rebase、**真冲突停住且工作区未损坏**、敏感文件拒提交、父仓库内建库/拒绝、push/pull 单向、`extraIgnores`、缺 git 身份时的回退身份、未配置远端 |
| `tests/turn-sync.test.mjs` | 真实 `turn/end` 监听器：区域内触发、区域外忽略、`syncAllOnTurnEnd`、连发合并为一次、开关关闭、失败不抛出 |
| `tests/portable.test.mjs` | 便携清单往返：机器本地字段永不入清单；机器本地变化不产生噪声提交 |
| `tests/client-card.test.mjs` | 把 `lib/client.js` 按浏览器模块表加载，断言注册契约并遍历渲染出的元素树（卡片 + 状态按钮） |

> 测试进程会设 `GIT_CEILING_DIRECTORIES`：某些机器上**家目录本身就是 git 仓库**，
> 否则临时目录会被误判为「位于父仓库内部」。

---

## 验证状态

| 环境 | 验证到什么 |
|---|---|
| Windows + Node 24 | 43/43 测试；实时 GUI 启动图含 `dsh-sync-tool` 且 bundle 路由 200；`--dump-config` 行合成正确；**真实运行时**经命令通道端到端推送成功；**真实对话轮次**驱动 `turn/end` 自动同步成功（提交信息带真实轮次号） |
| Debian 13 (WSL1) + Node 22 | 43/43 测试；**无头 profile 挂载**（无 web 栈、无浏览器半边）；组合行 `config` 配置工作区域可用；长驻 `dsh web` 下真实推送到 bare 远端；**跨机导入**成功；`file:` 安装经真实启动挂载成功 |
| 交付物自足性 | 从 `HEAD` 全新克隆（16 个文件）+ 提供唯一运行时依赖 → 构建成功、测试全绿 |

**尚未验证**（不当作已验证）：

- **需要认证的 HTTPS 推送** —— 没有可用的 HTTPS 远端；只单独验证了「环境变量注入 git 配置」
  这条机制本身可用。
- **卡片与状态按钮在真实浏览器里的视觉呈现** —— 元素树与注册契约已验证，但没有浏览器环境。
- **tarball / npm registry 安装** —— 只实测了 `file:` 与 `link:`。
- **一次性任务模式**下的同步 —— 已知边界，见上。
- **真实独立服务器** —— 未做。

---

## 许可

[MIT](./LICENSE) © 2026 YuKikAzE

与上游 DeepSeek Harness 保持同一许可。本插件**未内联任何第三方代码**：
运行时只依赖 Node 内建模块、`@deepseek-ai/schemastery`（依赖，非拷贝），
以及由客户端模块表提供的 `react`。
