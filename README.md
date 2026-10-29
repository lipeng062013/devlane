# DevLane

给程序员自己用的 AI 任务台。描述一个缺陷或需求，DevLane 为它单独建一个 git worktree 和分支，让本机的 Claude Code 在里面干活。你看着过程，审阅 diff，跑测试，满意了就提交、推送、开 PR；不满意就追问或丢弃。**你当前的工作目录始终不被碰。**

- 运行在你自己的电脑上，只监听 `127.0.0.1`
- 调用你本机已经登录的 `claude` 命令，不需要另外配模型密钥
- 能从 Jira 列表里选 issue，一键变成任务；可选开关回写评论（默认关，不做 transition）
- 项目路径手动输入，支持任意本地 git 仓库

使用方法见 [docs/02-使用手册.md](docs/02-使用手册.md)，产品设计见 [docs/01-产品设计.md](docs/01-产品设计.md)。

## 运行

需要：Node 20+、git、已登录的 Claude Code（`claude` 命令）。创建 PR 还需要 [GitHub CLI](https://cli.github.com/)（`gh auth login`）。

```bash
npm install
npm run build
npm start          # 启动并自动打开浏览器：http://127.0.0.1:7788
```

换端口：`node dist/server.mjs --port 7799`。数据目录默认 `~/.devlane`，可用环境变量 `DEVLANE_HOME` 改。

## 部署到服务器（只能通过 SSH 隧道访问）

DevLane 没有登录，能在运行它的机器上执行命令，所以**服务只监听服务器的 127.0.0.1，不对公网开放**。部署脚本：

```powershell
.\deploy\deploy.ps1 -InspectOnly   # 只读检查服务器
.\deploy\deploy.ps1                # 测试、打包、上传、安装、验证（默认端口 7790）
.\deploy\tunnel.ps1                # 建立隧道，然后浏览器打开 http://127.0.0.1:7790
.\deploy\deploy.ps1 -Uninstall     # 卸载（保留数据）
```

- 用独立的 `devlane` 系统用户运行，**不是**有 sudo 和 docker 权限的账号；systemd 沙箱里只有 `/opt/devlane/home` 可写，限制 600M 内存、80% CPU。
- Node 和 Claude Code 都装在 `/opt/devlane` 下，不动系统软件包；不改 nginx、防火墙、Docker。
- 部署前后对比服务器上的监听端口、运行服务和容器，已有项消失会报警并退出；新版本健康检查失败会自动回退。
- 服务器上的 claude 需要你自己提供认证，见 `docs/02-使用手册.md` 第 13 节。
## 开发

```bash
npm run typecheck   # 服务端 + 前端类型检查
npm test            # 206 项测试（含真实 git 操作）
npm run build
```

真实环境验证（会调用真实的 Claude，产生少量费用）：

```bash
node dist/server.mjs --port 7799        # 终端 1，建议先设 DEVLANE_HOME 到临时目录
node scripts/e2e-real.mjs http://127.0.0.1:7799       # 修缺陷、审阅、测试、提交、追问、丢弃
node scripts/e2e-approval.mjs http://127.0.0.1:7799   # 被拦截 → 放行 → 续接
```

## 目录

```
packages/
  app/    本地服务：git worktree、Claude 适配器、权限、任务调度、Jira 客户端、HTTP API
  web/    React 前端
  adf/    Atlassian 文档格式转 Markdown（Jira 描述用）
scripts/  构建、真实环境验证、界面截图
docs/     产品设计、使用手册；archive-团队版/ 是之前面向团队的设计（已废弃）
```

团队版（事件链、状态机、策略引擎、服务器部署）的完整代码保留在 git 标签 `v0.1-team-demo`。

## 安全模型

这个服务能在你的电脑上运行命令，所以：

- 只监听 `127.0.0.1`，并校验 `Host`（防 DNS 重绑定）；写操作必须带自定义请求头、`Origin` 必须是本机（防其他网页偷调）。
- Claude 在独立 worktree 里工作；权限通过 `--settings` 文件明确给出，**永久禁止** `git commit / push / reset / checkout / clean`、`rm`、`sudo`、`curl`、`gh` 等，这些即使你点「放行」也不行。
- 需要审批的操作（装依赖、联网等）被自动拒绝并记录，由你逐条决定是否放行，精确到那一条命令。
- Jira Token 只保存在 `~/.devlane/state.json`，接口永不返回，不写日志。
- Jira 评论回写验收只用 mock / FakeJira，禁止连真实 Atlassian 站发写请求。

不覆盖的风险：Claude 通过被允许的测试命令间接运行仓库里的恶意脚本。对不可信仓库请先自行评估。

## 已知限制

- 目前只支持 Claude Code；适配器接口已留好，可以加 `kiro-cli`、`codex`。
- Jira 客户端用夹具和假服务器验证过请求格式，**尚未对真实的 Jira 站点联调**，需要你填入凭据后确认。
- 费用显示来自 claude 自己的统计；续接会话时是否累计取决于 claude 的实现，界面上的数字仅供参考。
- 没有多人协作功能；单用户、单机。
