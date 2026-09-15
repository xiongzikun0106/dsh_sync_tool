# dsh-sync-tool

`dsh-sync-tool` 是一个 DeepSeek Harness（DSH）插件：你选定若干「工作区域」目录并为每个目录配上**你自己的**远程 git 仓库，它在**每轮对话结束后**自动把这些目录提交、拉取、合并并推送；落在这些目录里的 DSH **会话记录**也一起走，在另一台电脑上会被还原成**可以直接继续对话的原生会话**。它面向的需求是：把散在多台机器上的 DSH 资产（插件源码、agent 预设、技能、项目文件）用你自己的 git 仓库串起来，并且连「上一次聊到哪儿了」一起搬过去。

插件是一个普通的 **bundle 包**，装进某个 profile 就能用；它**不向模型注册任何工具**，不出现在工具列表里，也不会往对话里插入任何可见消息。

## 特性一览

- **每轮对话结束自动同步**：监听会话的 `turn/end` 事件，默认只同步与当前会话工作目录相关的区域。
- **双向同步**：识别仓库 → 对齐 `origin` → 提交 → 拉取合并 → 推送；`direction` 支持 `both` / `push` / `pull`。
- **会话记录随目录走**：工作区域内的会话被导出成规范 JSONL，写进 `<区域>/.dsh-sessions/`，随同一次 git 提交推送出去。
- **原生还原**：在另一台机器上经 DSH 官方的持久化写入路径重建会话 —— 同一个 session id、同一份 header、同一条事件序列。
- **缓存友好**：默认不改写会话记录里的 `cwd`，续聊时历史逐字节相同，命中已有的前缀缓存。
- **设备提示**：来自别的机器的历史，会被写进模型每次都读的「当前运行上下文」，不新增任何界面元素。
- **可移植清单**：每个被同步的目录根写入 `.dsh-sync.json`（只含机器无关信息），另一台机器一键接管。
- **安全默认**：内置忽略规则 + 提交前敏感文件拦截 + 凭据只以环境变量注入 git，不落盘、不进 argv。
- **不打扰对话**：轮次钩子是提交后、fire-and-forget 的，同步失败只写进插件自己的状态与历史。

## 它同步什么

**会被同步的**：你在设置卡里显式添加的**工作区域目录**，以及这些目录里的 DSH 会话记录（`sessions.enabled` 为真时）。目录还不是 git 仓库时，首次同步会自动 `git init`、补齐一份基础 `.gitignore`、提交并推送。

会话记录的落点是工作区域内的归档目录：

```
<工作区域>/.dsh-sessions/<sessionId>.jsonl.zstd     # 默认，zstd 压缩
<工作区域>/.dsh-sessions/<sessionId>.jsonl          # compression: none 时
```

> ⚠️ **隐私提醒**：开启会话同步后，**对话内容本身**会进入这个归档 —— 你的消息、模型的回复、工具调用的参数与输出、以及记录下来的本机绝对路径。归档位于工作区域之内，因此会**随同 git 提交推送到你为该区域配置的远程仓库**。远端是你自己选的那个仓库，但请按「它会保存你和模型的全部对话」来对待它：放私有仓库，不要放公共仓库；换机器、共享仓库、清理历史时都请把这一点算进去。

**明确不会被同步的**：

| 项目 | 说明 |
|---|---|
| `node_modules/`、`lib/`、`dist/`、`*.log` | 内置忽略规则，写进该目录的 `.gitignore`，不参与提交 |
| `.credentials.yaml`、`settings.yaml` | 内置忽略规则；且暂存区一旦出现这类文件会**拒绝自动提交**并报错 |
| `.env`（含 `.env.*`）、`.netrc`、`id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa` | 命中即拒绝自动提交（`guardSensitive`），不会推上去 |
| 会话的**附件与图片字节** | 归档只含会话记录本身（header + 事件序列），不含媒体文件 |
| 你的凭据值 | 只在拼装 git 命令的瞬间以环境变量注入；不写进 `.git/config`、不落盘、不进命令行参数 |
| 未添加的目录 | 插件只处理你显式添加的工作区域，不会自行扩大范围 |

每个工作区域的根目录还会被写入一份 `.dsh-sync.json`，只记录**机器无关**的字段：名称、远端、分支、方向、自动提交、敏感文件保护、父仓库策略、附加忽略规则。绝对路径、区域 id、启用状态与凭据引用不会离开本机。

## 环境要求

- DeepSeek Harness，`dsh` 命令可用。
- `git` ≥ 2.31 —— 凭据通过 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` 注入，git 2.31 起才与 `-c` 等价。
- Node 运行时需提供 `node:zlib` 的 Zstandard 支持（DSH 自身即要求这一点）；`sessions.compression` 设为 `none` 时不需要该能力。
- 一个你自己可写的远程 git 仓库（HTTPS 或 SSH 均可）。

路径比较对 Windows 与 POSIX 分别处理：Windows 下大小写不敏感、分隔符混用也能对上，POSIX 下保持大小写敏感。

## 安装

插件是一个 **DSH bundle 包**：`dsh plugin add` 会把该包追加进 profile 的 bundle 列表，而包自带的 patch 层（`cordis.patch.yml`）在合成时插入宿主半边的加载行。**bundle 列表只在 dsh 启动时读取一次，所以安装完必须重启 dsh**；浏览器半边首次出现时还需要刷新页面。包在 `package.json` 里标记为 `private`，未发布到 npm，从源码构建安装即可。

**方式一：从源码打包安装（推荐）**

```sh
npm pack                     # 打包前会自动构建（prepare 脚本），无需先装依赖
                             # 生成 dsh-sync-tool-<version>.tgz

dsh plugin --profile <profile> add ./dsh-sync-tool-<version>.tgz
# 然后重启 dsh
```

`files` 白名单只含 `lib/*.js` 与 `cordis.patch.yml`，构建是把 `src/` 拷成 `lib/` 并包一层浏览器侧的工厂函数，因此单独执行 `npm run build` 也可以，且不需要任何依赖。

**方式二：直接把仓库目录装进去（开发时用）**

```sh
npm run build
dsh plugin --profile <profile> add <仓库的绝对路径>
```

`dsh plugin` 把参数转发给 profile 目录里的 pnpm；为避免路径解析歧义，请使用**绝对路径**。以目录方式安装时 pnpm 走的是链接，本包自身的依赖不会被一并安装 —— 若启动时出现模块解析失败，在插件目录里执行一次 `npm install`，或改用方式一的 tarball。

卸载：`dsh plugin --profile <profile> remove dsh-sync-tool`

## 快速开始

1. 重启 dsh。启动日志里出现下面这行，说明宿主半边已挂载：

   ```
   [sync-tool] host half loaded (namespaces "sync-tool", "sync-tool-status", ...)
   ```

   也可用 `dsh --profile <profile> --dump-config` 确认配置里多了 `sync-tool` 这一行。

2. 打开 **设置 → Plugins → Plugin configuration**，找到「工作区域 Git 同步」卡片。
3. 点 **「选择目录并添加」**，用系统目录选择器挑一个目录；选择器不可用时用下方的输入框手填绝对路径。卡片上还有一个 `+ 预设目录` 快捷按钮，直接添加 `$DSH_HOME/.agent-presets`。
4. 在该区域行里填 **远端**（例如 `https://github.com/<you>/<repo>.git`）与 **分支**；私有仓库在 **凭据** 里填凭据名，公开仓库或已配好系统 git 凭据时留空。
5. 点 **「立即同步全部」**。首次同步会初始化仓库、提交并推送。

此后每轮对话结束都会自动同步。新增的浏览器侧界面元素需要**刷新页面**才会出现。

## 界面说明

**设置 → Plugins → Plugin configuration** 里的「工作区域 Git 同步」卡片：

| 区域 | 内容 |
|---|---|
| 顶部开关 | 启用插件、每轮对话后同步、启动时同步、每轮同步全部区域、同步会话记录，以及防抖毫秒数 |
| 工作区域列表 | 每行：启用勾选、目录路径、当前状态、移除按钮；下面是 名称 / 远端 / 分支 / 凭据 / 方向，以及 自动提交、敏感文件保护、父仓库内建库 三个选项 |
| 操作按钮 | 选择目录并添加、+ 预设目录、立即同步全部、从仓库导入、手动路径 + 添加路径 |
| 同步状态 | 空闲还是同步进行中、最后更新时间，以及最近 10 条同步历史 |

**对话页头部右上角**的状态指示器：一个圆形状态点 + 文字（待同步 / 同步中 / 已同步 / 冲突 / 错误；未配置任何区域时显示「未配置」，读不到宿主状态时显示「不可用」或「读取中」），后面跟着已配置的工作区域数量。点开后展开明细：每个区域的名称、状态、`HEAD`、领先/落后提交数、失败原因或上次成功的摘要，以及最近 5 条历史。

## 每轮同步的行为与时序

- **触发**：会话事件 `turn/end`。默认只同步**包含当前会话工作目录**（`session.header.cwd`）的区域；没有任何区域匹配时跳过，除非打开「每轮同步全部区域」。
- **合并**：`debounceMs` 窗口内多次轮次结束会合并成一次同步；全局同一时刻只跑一个 git 序列，后来的请求排队等待。
- **不阻塞对话**：监听器在轮次提交之后触发、异常被吞掉，同步再慢再失败也不会拖慢或打断对话。

单次区域同步的顺序（会话同步嵌在其中的两个位置）：

1. 把该区域的配置写成 `.dsh-sync.json`，让仓库自描述。
2. 识别仓库：`git rev-parse --show-toplevel`；不是仓库则 `git init -b <branch>`；目录位于**另一个** git 仓库内部时默认在内部建立独立仓库，配置成 `nestedRepos: refuse` 则报错拒绝。
3. 对齐 `origin`：没有就 `remote add`，地址不同就 `remote set-url`。
4. **【导出会话】** 把该区域范围内的会话写进 `.dsh-sessions/`。必须在提交之前。
5. 提交本地变更：有变更时先补 `.gitignore`（内置规则 + 该区域的 `extraIgnores`，只追加缺失的行，不重写已有内容），再 `git add -A`，用提交信息模板 `git commit --no-verify`。暂存区命中敏感文件则拒绝提交并把该区域标记为错误。
6. 整合远端：`git fetch --prune origin`；远端有分支而本地还没有提交时检出远端分支；仅远端领先时 `git merge --ff-only`；双方都有新提交时 `git pull --rebase --autostash`。
7. **【导入会话】** 读 `.dsh-sessions/`。必须在合并之后，这样才看得到另一台机器刚发布的内容。
8. 推送：`git push -u origin <branch>`（`direction: pull` 时跳过）。
9. 推送后重新读取 ahead/behind 并发布状态，保证你看到的是当前真实值。

**冲突处理**：rebase 失败时立即 `git rebase --abort` 复原，工作区保持你原本的样子，该区域被标记为 `conflict`，详情里带 git 的原始报错。插件**不会自动解决冲突**，也不会改动你的文件；手工处理完之后，下一次触发会重试。

**提交身份**：优先使用本机自身的 git 身份，永不被覆盖。只有当 git 因缺少身份拒绝提交时，才用 `commitIdentity` 配置的身份或派生的 `dsh-sync@<主机名>` 重试一次，并在状态里注明用了回退身份。

## 配置项

设置卡里能改的字段直接编辑；其余字段写在 profile 的 `cordis.patch.yml` 中该行的 `config` 下，或写进 `$DSH_HOME/settings.yaml` 的 `sync-tool` 段。配置分层为 **schema 默认值 → 组合行的 `config` → 用户设置文档**，卡片写入的是用户层。

### 顶层

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关，关掉后不做任何自动同步 |
| `syncOnTurnEnd` | `true` | 每轮对话结束后同步 |
| `syncOnStartup` | `false` | 宿主启动时对所有启用的区域跑一次 |
| `syncAllOnTurnEnd` | `false` | 每轮同步全部启用区域；关闭时只同步包含当前会话工作目录的区域 |
| `debounceMs` | `5000` | 轮次边界的合并窗口（毫秒） |
| `commitMessageTemplate` | `dsh-sync: {host} {time} (turn {turn})` | 提交信息模板，`{host}` `{time}` `{turn}` 会被替换 |
| `commitIdentity` | `{ name: "", email: "" }` | **仅当**本机没有 git 身份时使用的提交身份；留空则回退到 `dsh-sync@<主机名>` |
| `historyLimit` | `20` | 状态文档保留的历史条数 |
| `areas` | `[]` | 工作区域列表 |
| `request` | `{ token: 0, areaId: "", kind: "none", at: 0 }` | 界面 → 宿主的命令通道，由卡片维护：每次请求把 `token` 加一，`kind` 为 `sync` 或 `import` |
| `sessions` | 见下表 | 会话记录同步 |

### `areas[]` 中的单个工作区域

| 字段 | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | 稳定标识，添加时自动生成，不复用 |
| `path` | 必填 | 本机绝对路径 |
| `name` | `""` | 显示名；留空时界面显示目录名 |
| `remote` | `""` | 远端 git 地址；留空表示尚未配置远端，只做本地提交 |
| `branch` | `main` | 跟踪的远端分支 |
| `credentialRef` | `""` | 凭据名，经 DSH 的凭据服务解析；留空则用系统 git 凭据 |
| `direction` | `both` | `both` 先拉再推 / `push` 只推 / `pull` 只拉 |
| `enabled` | `true` | 是否参与自动同步 |
| `autoCommit` | `true` | 同步前自动提交本地变更 |
| `extraIgnores` | `[]` | 追加进该目录 `.gitignore` 的忽略规则 |
| `guardSensitive` | `true` | 暂存区出现敏感文件时拒绝自动提交 |
| `nestedRepos` | `init` | 目录位于另一个 git 仓库内部时：`init` 在内部建立独立仓库 / `refuse` 报错拒绝 |

### `sessions`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否同步会话记录 |
| `dir` | `.dsh-sessions` | 工作区域内存放归档的子目录名 |
| `compression` | `zstd` | 归档编码：`zstd` 紧凑 / `none` 出可读、可 diff 的明文 |
| `includeDescendants` | `true` | 是否包含工作目录在该区域**子目录**里的会话 |
| `maxSessions` | `200` | 每个区域最多同步多少条最新的在范围内会话 |
| `maxBytes` | `0` | 单条归档的字节上限，超出则跳过；`0` 表示不限 |
| `cwdPolicy` | `keep` | 导入时如何处理本机不存在的记录工作目录：`keep` / `auto` / `area`，见下节 |
| `hintOnDeviceSwitch` | `true` | 是否给模型注入「这段历史来自另一台电脑」的提示 |
| `statePath` | `""` | 机器本地记账文件；留空则用 `$DSH_HOME/sync-tool/sessions.json` |

### 没有图形界面时

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: sync-tool
  config:
    enabled: true
    syncOnStartup: true
    areas:
      - id: my-assets
        path: <你的工作目录>
        remote: https://example.com/<you>/<repo>.git
        branch: main
```

## 会话同步

这是本插件的第二个能力：把工作区域内的 DSH 会话记录同步到另一台电脑，并还原成**原生会话**。

### 归档格式

每条会话一个文件，内容是**规范 JSONL**（UTF-8，LF 换行）：第一行是 DSH 自身的物理 header 行（键白名单与键序一致，可选字段缺省即省略、不写 `null`），之后每行一个逻辑事件，按 `seq` 严格连续。

```
{"type":"session","version":3,"id":"...","createdAt":...,"cwd":"...","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
{"type":"user/message","seq":0,"time":...,"data":{...},"surfaceOp":"append"}
{"type":"tool/call","seq":1,"time":...,"data":{...}}
```

`compression: none` 时它是一份可以 diff、可以 review 的文本；默认用 `node:zlib` 的 zstd 压缩成 `.jsonl.zstd`。

**范围**：一条会话属于某个工作区域，当且仅当它的 header `cwd` 等于该区域或（`includeDescendants` 为真时）位于其子目录下；此外，**由该区域导入过**的会话始终继续随该区域同步 —— 否则在这台机器上对它做的续聊永远发布不回去。

### 导入：为什么是「原生会话」

导入不走字节拷贝，而是通过 DSH 的会话持久化契约 `create` → `append` → `flush` → `close` 重建：物理文件名与编码代际由本机后端自己决定，因此得到的是**一等公民**的本地会话 —— 可以列举、可以 `stat`、可以打开、可以继续聊，session id、header、每一条事件的 `seq` / `time` / 载荷都与归档逐条一致。fork（seed）出来的会话，其继承切点从归档里 `session/end-seed` 事件的 `seq` 反推，推不出来就报错跳过，绝不猜。

导入前还会校验：文件名与 header 里的 id 必须一致；归档格式版本必须是本机支持的版本；归档后缀必须与配置的 `compression` 一致。任何一条不满足都只记一条说明并跳过，**不会半途写入**。

### 缓存与 `cwdPolicy` 的关系

命中已有的前缀缓存需要**重建出的历史、当前的 envelope（系统提示、工作目录、工具表）和模型路由都一致**。本插件保证其中的历史部分：同一个 session id、同一条事件序列。

工作目录是另一半。DSH 的预设会把 `{{cwd}}` 渲染进系统提示，而系统提示位于 surface 的节点 0 —— 一旦改写 `cwd`，节点 0 就被替换，**前缀缓存从第 0 个 token 起失效**。因此：

| `cwdPolicy` | 行为 | 影响 |
|---|---|---|
| `keep`（默认） | 原样保留归档里记录的工作目录，即使它在本机不存在 | 历史与 envelope 都不变，缓存最容易被命中；代价是这台机器上该路径可能真的不存在 |
| `auto` | 记录的工作目录在本机存在就保留，不存在则改写为本机的工作区域路径 | 兼顾可用性；被改写时缓存会失效 |
| `area` | 一律改写为本机的工作区域路径 | 最本地化；总是改写 |

**想稳稳命中缓存，就让两台机器的工作区域使用同一个绝对路径**（例如同样的挂载点或同样的家目录结构），并保持默认的 `keep`。会话导入后是否被改写，会记录在本机的记账文件里并在状态中体现。

### 冲突如何处理

如果两台机器**离线各自续聊了同一条会话**（历史真正分叉），插件不做任何取舍：本机正在使用的那条保持原样、不动一个事件；归档里的远端分支与本机分支分别另存为 `<区域>/.dsh-sessions/conflicts/<id>.<归档mtime>.remote.jsonl` 与 `<id>.<归档mtime>.<主机名>.local.jsonl`（文件名稳定，重跑不会重复产生）；该区域的状态里报 `会话冲突`，并且这个判定会被记住，直到冲突被真正解决。

其余情况都是自动的：归档比本地长且本地历史是它的前缀，就只追加缺失的尾部；本地更长则不动本地，并由导出侧在两边一致后发布本机的续聊；两边完全一致时零读盘跳过。

### 模型可见的设备提示

当你在本机打开一条从别的机器同步过来的会话时，插件会通过系统提示的**运行上下文通道**追加一小段提示，告诉模型：这段历史是在另一台电脑上产生的，里面记录的绝对路径与工具输出都只是历史，动手前先确认路径是否存在。这段文字并进每个会话本来就有的「当前运行上下文」条目中，**不新增界面元素、不改动系统提示本身，因此已缓存的前缀逐字节不变**。它只对**由本机导入过的**会话出现，本机自己开的会话完全不受影响；用 `sessions.hintOnDeviceSwitch: false` 可以关掉。

### 记账与状态

机器本地记账文件（默认 `$DSH_HOME/sync-tool/sessions.json`，不随仓库走）记录两件事：每条会话上次导出的指纹（避免重复读盘），以及哪条会话是从哪台机器导入的（设备提示与「归属」的依据）。文件损坏或丢失只会让下一次同步多读一遍，不会出错。

同步时区域详情里会出现这样的片段：`会话↑N`（导出 N 条）、`会话↓M`（新建 M 条）、`会话并入M`（追加尾部）、`会话冲突K`、`会话失败K`。

## 跨电脑使用

**第一台机器**：按上面的步骤安装插件（记得重启 dsh）并刷新页面 → 在卡片里添加工作区域并填好远端、分支、凭据 → 点「立即同步全部」，让目录里生成 `.dsh-sync.json` 与 `.dsh-sessions/` 并推送成功。此后每轮对话结束都会自动同步，会话也随之一条条发布出去。

**第二台机器**：`git clone <远端> <本机目标目录>`（目录路径与第一台相同最好，见上文缓存一节） → 安装同一个插件并重启 dsh → 打开卡片点 **「从仓库导入」** 并选中刚 clone 的目录，插件读取其中的 `.dsh-sync.json` 并在本机生成一条新的工作区域（**路径是本机的、id 是新的、凭据引用为空**，其余沿用清单） → 触发一次同步（每轮对话结束，或点「立即同步全部」），`.dsh-sessions/` 里的会话会被还原成本机原生会话，在会话列表里就能打开并接着聊。

**注意事项**：别把 `.dsh-sessions/` 加进 `.gitignore`，否则归档不会随提交走；两台机器的 `sessions.compression` 要一致，后缀与配置不符的归档会被跳过并记录说明；两台机器同时编辑同一条会话会产生真正的分叉，按上文的冲突规则处理。

## 常见问题

| 现象 | 处理 |
|---|---|
| 卡片或头部状态按钮不出现 | 确认安装后**重启了 dsh**（bundle 只在启动时读一次），用 `dsh --profile <profile> --dump-config` 确认有 `sync-tool` 行，然后刷新页面 |
| 状态显示「不可用」 | 宿主半边没有加载，见上一条 |
| 某个区域一直是「错误」 | 卡片里该区域的详情就是原因，里面带 git 的原始输出 |
| 推送失败 | 详情里有 git 的 stderr；据此判断是远端地址、网络还是凭据问题 |
| 显示「冲突待处理」 | 本地与远端改了同一处，rebase 已中止、你的文件没有被改动；手工处理完后下一次同步会重试 |
| 会话没同步过去 | 检查 `sessions.enabled`、该会话的 `cwd` 是否在区域内（或打开 `includeDescendants`）、`.dsh-sessions/` 是否被忽略规则挡住、远端是否收到了提交 |
| 会话同步了但模型不知道换了设备 | 确认 `sessions.hintOnDeviceSwitch` 为真，且这条会话确实是由本机导入的 |
| 提示找不到模块 / `Cannot find module` | 以目录方式安装不会装本包依赖；在插件目录执行 `npm install`，或改用 tarball 安装 |
| 改了代码不生效 | 宿主半边改动需要重启 dsh；浏览器半边改动需重新 `npm run build` 后刷新页面 |
| 状态一直停在「同步中」 | 进程在同步途中退出了（一次性任务模式会这样）；持续运行的会话不受影响 |

## 开发与测试

```sh
npm run build              # 构建：宿主半边到 lib/*.js，浏览器半边到 lib/client.js
npm test                   # 全部单元与集成测试（node:test，72 项）
npm run test:sessions-e2e  # 会话同步的真后端端到端校验
```

`test:sessions-e2e` 驱动 DSH 自己的包（`@deepseek-ai/dsh-session-persistence-jsonl` 与 `@deepseek-ai/dsh-system-prompt`），验证四件事：插件写出的规范文本与后端未压缩时写出的文本逐行一致；从一个会话根导出的会话能在另一个根里以同样的 id、header 和事件序列重建；重建出来的会话在那里是一等公民（可列举、可 `stat`、读回内容一致）；设备提示能被真实的提示词注册表接受、渲染进运行上下文快照，而对本机自己的会话完全不出现。它需要一个装有 DSH 官方 `@deepseek-ai/*` 包的 profile 根目录：

```sh
node scripts/e2e-sessions.mjs [profile-root]
# 省略时依次取 $DSH_PROFILE_ROOT、$DSH_HOME/profiles
```

该脚本全程使用临时目录，不会碰你机器上真实的会话存储。

代码分为两半：`src/host/`（`index.js` 宿主入口与轮次钩子、`git.js` git 引擎、`sessions.js` 会话归档引擎、`notice.js` 设备提示、`portable.js` 可移植清单）与 `src/client/index.js`（浏览器侧设置卡与头部状态指示器）。浏览器半边必须是客户端模块表要求的惰性 CJS 闭包工厂（`window.__ModuleLoader__.load({ id, factory })`），由 `scripts/build.mjs` 生成；React 通过工厂注入的 `require('react')` 取得，不允许跨插件值导入 —— 因此卡片自己渲染自己的控件。

## 许可

[MIT](./LICENSE)
