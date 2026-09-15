# dsh-sync-tool

把你选定的文件夹，在每轮对话结束后自动同步到你自己的远程 git 仓库。
用来在多台电脑之间同步 DeepSeek Harness 的插件、预设、技能等工作内容。

插件不向模型注册任何工具，也不会出现在对话里。

---

## 它同步什么

**同步**：你在界面上选定的**工作区域目录**里的内容，按 git 的规则走（受该目录的 `.gitignore` 约束）。
目录还不是 git 仓库时，首次同步会自动完成初始化：`git init`、写入一份基础 `.gitignore`、提交、推送到你配置的远端。

**不涉及**：

| | |
|---|---|
| 对话内容与会话记录 | 插件**从不读取**它们。会话记录存放在 `$DSH_HOME/sessions`；只有你把该目录本身选为工作区域，它才会被当作普通文件参与同步——通常不应该这么做 |
| `node_modules/`、`lib/`、`dist/`、`*.log` | 默认忽略，不会提交 |
| `.credentials.yaml`、`settings.yaml`、`.env`、私钥 | 默认忽略；且暂存区一旦出现这类文件会**拒绝提交**并报错 |
| 未选择的内容 | 插件只处理你显式添加的工作区域，不会自行扩大范围 |

每个被同步的目录根会写入一份 `.dsh-sync.json`（只含机器无关信息），供另一台电脑一键接管该目录。

---

## 界面

| 位置 | 用途 |
|---|---|
| **设置 → Plugins → Plugin configuration** 里的「工作区域 Git 同步」卡片 | 添加/删除工作区域、填远端与分支、选方向与选项、立即同步、从仓库导入、查看状态与历史 |
| **会话头部右上角**的状态按钮 | 总体状态一眼可见（同步中 / 已同步 / 冲突 / 错误），点开看每个区域的状态、HEAD、领先落后与历史 |

---

## 环境要求

- DeepSeek Harness（`dsh` 命令可用）
- git ≥ 2.31（凭据通过环境变量注入 git 配置，需要此版本以上）
- Node 版本跟随 DSH 自身要求

---

## 安装

插件是一个普通的 DSH bundle 包，装进某个 profile 即可。

### 从源码打包安装

```sh
# 1. 在插件目录里构建并打包
npm run build
npm pack                     # 生成 dsh-sync-tool-0.1.0.tgz

# 2. 装进目标 profile（<profile> 换成 web、headless 或你自己的）
dsh plugin --profile <profile> add ./dsh-sync-tool-0.1.0.tgz

# 3. 重启该 profile —— 新增 bundle 只在启动时读取一次
```

### 从 npm 安装（发布后）

```sh
dsh plugin --profile <profile> add dsh-sync-tool
```

### 参与开发

把插件目录链接进 profile，改完代码刷新页面即可生效、不必重启：

```sh
dsh plugin --profile <profile> add <插件目录的绝对路径>
```

链接方式不会安装本包的依赖，因此需要在插件目录里自备 `node_modules`
（`npm install` 即可）。分发请用上面的 tarball 或 npm 方式。

---

## 使用

1. 启动 DSH。日志里出现这一行说明宿主半边已挂载：

   ```
   [sync-tool] host half loaded (namespaces "sync-tool", "sync-tool-status")
   ```

2. 打开 **设置 → Plugins → Plugin configuration**，找到「工作区域 Git 同步」卡片。
3. 点 **「选择目录并添加」**，用系统目录选择器选一个文件夹。
   选择器不可用时，下方的输入框可以手填绝对路径。
4. 在该区域行里填 **远端**（如 `https://github.com/you/dsh-sync.git`）和 **分支**。
   私有仓库在 **凭据** 里填凭据名；公开仓库或已配好系统 git 凭据时留空即可。
5. 点 **「立即同步全部」**。首次同步会初始化仓库并推送。

此后每轮对话结束都会自动同步。新增的界面元素需要**刷新页面**才会出现。

---

## 每轮同步的行为

- **触发时机**：每轮对话结束。默认只同步**包含当前会话工作目录**的区域；
  打开「每轮同步全部区域」则每轮同步所有已启用的区域。
- **合并触发**：`debounceMs` 窗口内的多次轮次结束会合并成一次同步；全局同一时刻只跑一个 git 序列。
- **一次同步的顺序**：识别仓库 → 对齐 `origin` → 提交本地变更 → 拉取并整合 → 推送。
  仅远端领先时快进合并；双方都有新提交时用 `pull --rebase --autostash`。
- **冲突**：`rebase --abort` 复原并把该区域标记为 `conflict`，**不会自动解决、不会改动你的文件**。
  详情里带上 git 的原始报错，处理完下一次触发会重试。
- **提交身份**：优先用机器自身的 git 身份。机器没有配置 git 身份时会改用
  `dsh-sync@<主机名>`（或你在配置里指定的 `commitIdentity`）并在状态里注明。
- **凭据**：`credentialRef` 填的是**凭据名**，值由 DSH 的凭据库提供，
  以环境变量注入的形式传给 git，不会进入命令行参数、不会写进 `.git/config`、不会落盘。

---

## 配置项

界面上能改的字段在卡片里直接编辑；其余写在 profile 的 `cordis.patch.yml`
或 `$DSH_HOME/settings.yaml` 里。

### 顶层

| 字段 | 默认 | 说明 | 界面可改 |
|---|---|---|---|
| `enabled` | `true` | 总开关 | ✅ |
| `syncOnTurnEnd` | `true` | 每轮对话结束后同步 | ✅ |
| `syncOnStartup` | `false` | 宿主启动时同步一次 | ✅ |
| `syncAllOnTurnEnd` | `false` | 每轮同步全部启用区域（默认只同步包含当前会话工作目录的） | ✅ |
| `debounceMs` | `5000` | 防抖窗口（毫秒） | ✅ |
| `areas` | `[]` | 工作区域列表 | ✅ |
| `commitMessageTemplate` | `dsh-sync: {host} {time} (turn {turn})` | 提交信息模板 | ❌ |
| `historyLimit` | `20` | 状态里保留的历史条数 | ❌ |
| `commitIdentity` | `{ name: "", email: "" }` | 机器没有 git 身份时使用的提交身份 | ❌ |

### 单个工作区域

| 字段 | 默认 | 说明 | 界面可改 |
|---|---|---|---|
| `id` | 必填 | 稳定标识，添加时自动生成 | — |
| `path` | 必填 | 目录的绝对路径 | 添加时选择 |
| `name` | `""` | 显示名 | ✅ |
| `remote` | `""` | 远端地址；留空则只做本地提交 | ✅ |
| `branch` | `main` | 跟踪的分支 | ✅ |
| `credentialRef` | `""` | 凭据名；留空则用系统 git 凭据 | ✅ |
| `direction` | `both` | `both` 先拉再推 / `push` 只推 / `pull` 只拉 | ✅ |
| `enabled` | `true` | 是否参与自动同步 | ✅ |
| `autoCommit` | `true` | 同步前自动提交本地变更 | ✅ |
| `guardSensitive` | `true` | 暂存区出现敏感文件时拒绝提交 | ✅ |
| `nestedRepos` | `init` | 目录位于另一个仓库内部时：`init` 在其内部建立独立仓库 / `refuse` 拒绝操作 | ✅ |
| `extraIgnores` | `[]` | 追加到 `.gitignore` 的忽略规则 | ❌ |

### 无图形界面时

用组合行自己的 `config` 配置工作区域：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: sync-tool
  config:
    enabled: true
    areas:
      - id: my-plugins
        path: /home/me/dsh-plugins
        remote: https://github.com/me/dsh-sync.git
        branch: main
```

---

## 跨电脑使用

**第一台机器**

1. 按上面的方式安装并配置工作区域，同步成功一次。
2. 被同步的目录里会生成 `.dsh-sync.json`，随提交一起进入远端。

**第二台机器**

1. `git clone <远端> <目标目录>`
2. 同样安装本插件。
3. 打开配置卡片，点 **「从仓库导入」**，选中刚 clone 的目录。
   插件会读取 `.dsh-sync.json`，在本机生成一个新的工作区域：
   **路径是本机的、id 是新的、凭据引用为空**，远端与分支沿用清单。

`.dsh-sync.json` 只记录机器无关的字段（名称、远端、分支、方向、自动提交、
敏感文件保护、父仓库策略、附加忽略）。绝对路径、区域 id、启用状态与凭据引用都不会离开本机。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 卡片或状态按钮不出现 | 确认 profile 里合成了本插件的行（`dsh --profile <profile> --dump-config`），确认启动日志有 `host half loaded`，然后刷新页面 |
| 某个区域一直是 `error` | 在卡片里看该区域的详情，它就是原因；git 的原始输出也在里面 |
| 推送失败 | 详情里带 git 的原始 stderr；据此判断是远端地址、网络还是凭据问题 |
| 界面显示状态「不可用」 | 宿主半边没有加载，见第一条 |
| 用目录路径安装后启动报找不到模块 | 链接方式不安装本包依赖；改用 tarball 或 npm 安装 |
| 冲突了怎么办 | `conflict` 表示本地与远端改了同一处且已复原，你的文件没有被改动；手动处理该文件后下一次同步会重试 |
| 改了插件代码不生效 | 宿主半边改动需要重启 profile；浏览器半边刷新页面即可 |
| 状态停在「同步中」 | 同步被进程退出打断（一次性任务模式下会发生）；持续会话不受影响 |

---

## 开发

```sh
npm run build     # 构建宿主与浏览器半边到 lib/
npm test          # 43 个测试
```

```
package.json          # 包清单：bundle 层、浏览器半边、导出与打包范围
cordis.patch.yml      # 作为 bundle 安装时插入的宿主行
scripts/build.mjs     # 构建脚本
src/host/             # 宿主半边：命名空间与轮次钩子、git 引擎、便携清单
src/client/           # 浏览器半边：配置卡片 + 状态按钮
tests/                # 宿主契约、真实 git 集成、轮次触发、便携清单、浏览器半边
```

浏览器半边必须是客户端模块表要求的惰性 CJS 闭包工厂
（`window.__ModuleLoader__.load({ id, factory })`），由 `scripts/build.mjs` 生成；
React 通过工厂注入的 `require('react')` 取得，且不允许跨插件值导入。

---

## 许可

[MIT](./LICENSE) © 2026 YuKikAzE
