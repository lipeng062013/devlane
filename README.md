# DevLane

面向研发团队的 AI 并行开发工作台。从需求池进，到 PR 出，中间每一步都看得见。

## 当前状态：可运行的成品（模拟执行器）

已经可以登录、建需求、开泳道、看泳道图实时推进、处理门禁、合并。

**执行器是模拟的**：它按脚本产生结构真实的事件（提交、测试失败、重试、换模型、门禁），经过真实的状态机、策略引擎和哈希链，但不调用模型，也不修改任何代码。界面右上角有「模拟执行器」标记。接入真实执行器需要模型密钥和沙箱（见「尚未完成」）。

### 功能

- **需求池**：就绪评分（验收标准、复现步骤、影响范围、优先级、截止时间、负责人），满 70 分才能开泳道；支持手动新建，配置 Jira 后可导入
- **泳道图**：每条泳道一行，事件按顺序成节点，实时推送（SSE），点节点看事件详情
- **调度**：排队、并发上限（默认 3）、暂停、恢复、放弃
- **策略与门禁**：改 `package.json` 等高风险文件会暂停并等你批准或拒绝；缺陷流水线在红测阶段改业务代码会被拒绝
- **可审计**：每条泳道的事件用 SHA-256 哈希链串联，界面上可一键校验
- **持久化**：事件存 SQLite（sql.js，无需编译），看板数据存 JSON，重启后从断点继续
- **认证**：口令登录，HttpOnly 会话 cookie，登录限流，基础安全头

## 本地运行

```bash
npm install
npm run typecheck   # 类型检查（服务端 + 前端）
npm test            # 103 个测试
npm run build       # 产物在 dist/
DEVLANE_PASSWORD=你的口令 npm start      # 默认 http://127.0.0.1:8787
```

开发时前端热更新：一个终端 `npm run dev:server`，另一个终端 `npm run dev:web`，打开 http://localhost:5173 。

PowerShell 设置环境变量：`$env:DEVLANE_PASSWORD='你的口令'; npm start`

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEVLANE_PASSWORD` | 随机生成并打印 | 登录口令 |
| `PORT` / `HOST` | 8787 / 127.0.0.1 | 监听地址 |
| `DEVLANE_DATA_DIR` | `./data` | 数据目录 |
| `DEVLANE_TICK_MS` | 2500 | 模拟执行器每步间隔 |
| `DEVLANE_MAX_PARALLEL` | 3 | 同时运行的泳道数 |
| `DEVLANE_SEED_DEMO` | 开启 | 设为 `0` 则首次启动不放示例需求 |
| `JIRA_BASE_URL` `JIRA_EMAIL` `JIRA_API_TOKEN` | 无 | 三项都设置后启用「从 Jira 导入」 |
| `JIRA_ACCEPTANCE_FIELD` | 无 | 验收标准所在的自定义字段 id |
| `JIRA_DEFAULT_JQL` | `statusCategory != Done ORDER BY created DESC` | 导入使用的 JQL |

## 部署到服务器

部署脚本不改 nginx、防火墙、Docker，不装系统软件包。它用独立目录 `/opt/devlane`、独立系统用户、独立端口，并用 systemd 限制内存与 CPU。部署前后会对比服务器上的监听端口、运行服务和容器，已有项目有任何一项消失就报警。

```powershell
.\deploy\deploy.ps1 -InspectOnly   # 只读检查服务器，不改任何东西
.\deploy\deploy.ps1                # 测试、打包、上传、安装、验证
.\deploy\deploy.ps1 -Uninstall     # 卸载（保留数据）
```

回退：每次升级保留最近 3 个版本，新版本健康检查失败时自动切回上一版本。

## 项目结构

```
packages/
  event-schema   事件类型、payload 校验、哈希链
  event-service  事件存储（SQLite，可落盘）
  state-machine  泳道状态机
  policy-engine  路径、命令、范围、高风险文件、缺陷阶段规则
  readiness      就绪评分
  adf            Atlassian 文档格式转 Markdown
  server         编排器、执行器接口与模拟执行器、Jira 连接器、HTTP API
  web            React 前端
deploy/          服务器端脚本与一键部署
scripts/         构建、发布、端到端冒烟（e2e-smoke.mjs）、界面检查（ui-check.mjs）
docs/            需求、PRD、技术设计、落地缺口
```

## 尚未完成

- **真实执行器**：`Executor` 接口已定义，需要模型 API 密钥与预算，以及沙箱（Docker 或更强隔离）。当前只有模拟执行器。
- **Jira 联调**：连接器已按 Jira Cloud 的 `/rest/api/3/search/jql` 实现并用夹具测试，尚未对真实站点联调。回写 Jira 状态未实现。
- **GitHub PR**：当前 PR 是模拟的（`simulated://pr/n`），未创建真实 PR。
- **评审打回**：状态机允许评审中打回到运行，界面和执行器脚本还没有对应的返工流程。
- **多用户**：目前是单一口令、单一用户 `admin`。
- **HTTPS**：服务本身是 HTTP。口令在明文链路上传输，正式使用前应放到 HTTPS 反向代理之后。

阻塞项详见 `docs/04-落地缺口分析.md`。
