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
| P1 | settings 命名空间 + 工作区域 CRUD + 目录选择 | ⏳ |
| P2 | git 引擎 + 手动同步 + 状态与历史 | ⏳ |
| P3 | `turn/end` 自动同步 + 防抖单飞队列 + 冲突停靠 | ⏳ |
| P4 | 跨机验证 + 便携清单 `.dsh-sync.yml` + 文档 | ⏳ |

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
