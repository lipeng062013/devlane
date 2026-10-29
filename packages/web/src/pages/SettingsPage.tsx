import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';

function JiraSettings() {
  const { state, act, notify } = useApp();
  const current = state.settings.jira;
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '');
  const [email, setEmail] = useState(current?.email ?? '');
  const [token, setToken] = useState('');
  const [defaultJql, setDefaultJql] = useState(current?.defaultJql ?? '');
  const [writeEnabled, setWriteEnabled] = useState(Boolean(current?.writeEnabled));
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<boolean> {
    const r = await act(() => api.saveJira({ baseUrl, email, apiToken: token || undefined, defaultJql, writeEnabled }));
    if (r) setToken('');
    return Boolean(r);
  }

  async function test(): Promise<void> {
    setBusy(true);
    setTestResult(null);
    try {
      if (!(await save())) return;
      const r = await api.testJira();
      setTestResult({ ok: true, text: `连接成功，当前用户：${r.user.name}${r.user.email ? `（${r.user.email}）` : ''}` });
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>Jira</h3>
      <p className="muted small">
        查询 issue；开启下方开关后，可把任务进展以<strong>评论</strong>回写到 Jira（默认关闭，不做状态流转）。
        Token 只保存在本机 <span className="mono">~/.devlane/state.json</span>，不会显示在界面上，也不会写进日志。
        验收与自检一律用 mock / FakeJira，禁止连真实 Jira 写数据。
      </p>
      <label>
        站点地址
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://house730.atlassian.net" />
      </label>
      <label>
        登录邮箱
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="off" />
      </label>
      <label>
        API Token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={current?.hasToken ? '已保存。留空表示保持不变' : '粘贴你的 API Token'}
          autoComplete="new-password"
        />
      </label>
      <p className="muted small">
        在 Atlassian 账号里创建：<a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer noopener">id.atlassian.com → 安全 → 创建 API 令牌</a>。
      </p>
      <label>
        默认 JQL（可选；不填则默认显示「指派给我且未完成」）
        <input value={defaultJql} onChange={(e) => setDefaultJql(e.target.value)} placeholder="project = HOUSE AND assignee = currentUser() ORDER BY updated DESC" className="mono" />
      </label>

      <label className="checkbox-row">
        <input type="checkbox" checked={writeEnabled} onChange={(e) => setWriteEnabled(e.target.checked)} />
        允许回写 Jira 评论（默认关闭；仅评论，不会改 issue 状态）
      </label>
      {testResult && <div className={`notice-inline ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.text}</div>}
      <div className="form-actions">
        {current && (
          <button
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm('清除已保存的 Jira 连接信息？')) void act(() => api.clearJira()).then(() => setToken(''));
            }}
          >
            清除
          </button>
        )}
        <span className="spacer" />
        <button className="btn" disabled={busy || !baseUrl || !email} onClick={() => void save().then((ok) => ok && notify('Jira 设置已保存'))}>
          保存
        </button>
        <button className="btn btn-primary" disabled={busy || !baseUrl || !email || (!token && !current?.hasToken)} onClick={() => void test()}>
          {busy ? '测试中…' : '保存并测试连接'}
        </button>
      </div>
    </section>
  );
}

function GeneralSettings() {
  const { state, act, notify } = useApp();
  const s = state.settings;
  const [claudePath, setClaudePath] = useState(s.claudePath ?? '');
  const [codexPath, setCodexPath] = useState(s.codexPath ?? '');
  const [grokBuildPath, setGrokBuildPath] = useState(s.grokBuildPath ?? '');
  const [model, setModel] = useState(s.model ?? '');
  const [budget, setBudget] = useState(String(s.maxBudgetUsd));
  const [concurrent, setConcurrent] = useState(String(s.maxConcurrent));
  const [editor, setEditor] = useState(s.editorCommand);

  return (
    <section className="card">
      <h3>Agent 与任务</h3>
      <label>
        Claude 命令路径（留空自动查找）
        <input value={claudePath} onChange={(e) => setClaudePath(e.target.value)} placeholder="例如 C:\Users\you\AppData\Local\Volta\bin\claude.cmd" className="mono" />
      </label>
      <label>
        Codex 命令路径（留空自动查找）
        <input value={codexPath} onChange={(e) => setCodexPath(e.target.value)} placeholder="例如 C:\Users\you\AppData\Local\Volta\bin\codex.cmd" className="mono" />
      </label>
      <label>
        Grok Build 命令路径（留空自动查找；本机实名 grok）
        <input value={grokBuildPath} onChange={(e) => setGrokBuildPath(e.target.value)} placeholder="例如 C:\Users\you\.grok\bin\grok.exe" className="mono" />
      </label>
      <div className="form-row">
        <label>
          模型（留空用 Agent 自己的默认设置）
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 sonnet、opus" />
        </label>
        <label>
          单次运行预算上限（美元）
          <input type="number" min={0.1} max={100} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
      </div>
      <div className="form-row">
        <label>
          同时运行的任务数（1 ～ 8）
          <input type="number" min={1} max={8} value={concurrent} onChange={(e) => setConcurrent(e.target.value)} />
        </label>
        <label>
          编辑器命令
          <input value={editor} onChange={(e) => setEditor(e.target.value)} placeholder="code" />
        </label>
      </div>
      <p className="muted small">预算是 Claude 每次运行的花费上限，超过会自动停止，你可以调高后点「继续」。</p>
      <div className="form-actions">
        <span className="spacer" />
        <button
          className="btn btn-primary"
          onClick={() =>
            void act(() =>
              api.saveSettings({
                claudePath,
                codexPath,
                grokBuildPath,
                model,
                maxBudgetUsd: Number(budget),
                maxConcurrent: Number(concurrent),
                editorCommand: editor,
              }),
            ).then((r) => r && notify('设置已保存'))
          }
        >
          保存
        </button>
      </div>
    </section>
  );
}


function PromptTemplateSettings() {
  const { state, act, notify } = useApp();
  const current = state.settings.promptTemplates;
  const [bug, setBug] = useState(current?.bug ?? '');
  const [feature, setFeature] = useState(current?.feature ?? '');

  return (
    <section className="card">
      <h3>Agent 提示模板</h3>
      <p className="muted small">
        按任务类型（缺陷 / 需求）自定义发给 Agent 的<strong>初始提示</strong>。留空则使用内置默认。支持占位符{' '}
        <span className="mono">{'{{title}}'}</span>、<span className="mono">{'{{description}}'}</span>、
        <span className="mono">{'{{jiraKey}}'}</span>、<span className="mono">{'{{testCommand}}'}</span>、
        <span className="mono">{'{{projectName}}'}</span>、<span className="mono">{'{{branch}}'}</span>、
        <span className="mono">{'{{baseBranch}}'}</span>、<span className="mono">{'{{kind}}'}</span>
        。与 Jira 字段独立，不回写。未知占位符原样保留。
      </p>
      <label>
        缺陷（bug）模板
        <textarea
          value={bug}
          onChange={(e) => setBug(e.target.value)}
          rows={10}
          className="mono"
          placeholder="留空 = 使用内置默认缺陷提示"
        />
      </label>
      <label>
        需求（feature）模板
        <textarea
          value={feature}
          onChange={(e) => setFeature(e.target.value)}
          rows={10}
          className="mono"
          placeholder="留空 = 使用内置默认需求提示"
        />
      </label>
      <div className="form-actions">
        <button
          className="btn"
          type="button"
          onClick={() => {
            setBug('');
            setFeature('');
          }}
        >
          恢复默认
        </button>
        <span className="spacer" />
        <button
          className="btn btn-primary"
          onClick={() =>
            void act(() => api.saveSettings({ promptTemplates: { bug, feature } })).then(
              (r) => r && notify('提示模板已保存'),
            )
          }
        >
          保存
        </button>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const { env, refreshEnv } = useApp();
  return (
    <div className="page-pad">
      <h1>设置</h1>
      <section className="card">
        <div className="card-head">
          <h3>环境检查</h3>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => void refreshEnv()}>
            重新检测
          </button>
        </div>
        <ul className="env-list">
          <li>
            <span className={env?.claude ? 'ok-dot' : 'bad-dot'} /> claude：{env ? (env.claude ?? '未找到。请安装 Claude Code，或在下面填写路径') : '检测中…'}
          </li>
          <li>
            <span className={env?.codex ? 'ok-dot' : 'bad-dot'} /> codex：{env ? (env.codex ?? '未找到。请安装 Codex CLI，或在下面填写路径') : '检测中…'}
          </li>
          <li>
            <span className={env?.grokBuild ? 'ok-dot' : 'bad-dot'} /> grok-build（本机实名 grok）：{env ? (env.grokBuild ?? '未找到。请安装 Grok Build，或在下面填写路径') : '检测中…'}
          </li>
          <li>
            <span className={env?.git ? 'ok-dot' : 'bad-dot'} /> git：{env ? (env.git ?? '未找到') : '检测中…'}
          </li>
          <li>
            <span className={env?.gh ? 'ok-dot' : 'warn-dot'} /> gh（创建 PR 用）：{env ? (env.gh ?? '未找到；只影响「推送并创建 PR」') : '检测中…'}
          </li>
        </ul>
      </section>
      <GeneralSettings />
      <PromptTemplateSettings />
      <JiraSettings />
    </div>
  );
}
