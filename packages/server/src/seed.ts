import type { Orchestrator } from './orchestrator';

/** 首次启动时放入的示例需求，覆盖就绪与未就绪两种情况，方便直接体验。 */
export async function seedDemoIssues(orchestrator: Orchestrator): Promise<void> {
  const demo = [
    {
      title: '登录页在 Safari 下提交按钮无响应',
      type: 'Bug',
      priority: 'High',
      dueDate: '2026-11-15',
      reporter: '产品-李雷',
      components: ['web/login'],
      markdown: [
        '## 复现步骤',
        '1. 用 Safari 17 打开登录页',
        '2. 输入账号和密码后点击「登录」',
        '',
        '## 期望结果',
        '页面跳转到工作台。',
        '',
        '## 实际结果',
        '按钮没有任何反应，控制台报 TypeError。',
        '',
        '## 验收标准',
        '- Safari、Chrome、Edge 下均可正常登录',
        '- 新增回归测试覆盖该场景',
      ].join('\n'),
    },
    {
      title: '看板支持按负责人筛选泳道',
      type: 'Story',
      priority: 'Medium',
      dueDate: '2026-11-30',
      reporter: '产品-韩梅梅',
      assignee: '前端-小王',
      components: ['web/board'],
      markdown: [
        '## 背景',
        '泳道变多后，个人只想看自己负责的部分。',
        '',
        '## 验收标准',
        '- 假设我在看板页，当我选择某个负责人，则只显示该负责人的泳道',
        '- 清除筛选后恢复全部泳道',
        '',
        '## 影响范围',
        'src/feature/ 下的筛选组件，不涉及后端接口。',
      ].join('\n'),
    },
    {
      title: '升级测试框架并清理告警',
      type: 'Task',
      priority: 'Low',
      dueDate: '2026-12-10',
      assignee: '后端-小张',
      components: ['tooling'],
      markdown: ['## 验收标准', '- `npm test` 全部通过且无弃用告警', '', '## 影响范围', 'src/index.ts 与测试配置。'].join(
        '\n',
      ),
    },
    {
      title: '导出报表偶尔为空',
      type: 'Bug',
      markdown: '用户反馈有时导出的报表是空的，需要看一下。',
    },
    {
      title: '做一个消息中心',
      type: 'Story',
      priority: 'Medium',
      markdown: '希望有统一的消息入口。',
    },
  ];
  for (const issue of demo) await orchestrator.createIssue(issue, 'demo');
}
