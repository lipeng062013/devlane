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
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<boolean> {
    const r = await act(() => api.saveJira({ baseUrl, email, apiToken: token || undefined, defaultJql }));
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
        只读：DevLane 只会查询 issue，不会修改 Jira。Token 只保存在本机 <span className="mono">~/.devlane/state.json</span>，不会显示在界面上，也不会写进日志。
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
  const [model, setModel] = useState(s.model ?? '');
  const [budget, setBudget] = useState(String(s.maxBudgetUsd));
  const [concurrent, setConcurrent] = useState(String(s.maxConcurrent));
  const [editor, setEditor] = useState(s.editorCommand);

  return (
    <section className="card">
      <h3>Claude 与任务</h3>
      <label>
        claude 命令路径（留空自动查找）
        <input value={claudePath} onChange={(e) => setClaudePath(e.target.value)} placeholder="例如 C:\Users\you\AppData\Local\Volta\bin\claude.cmd" className="mono" />
      </label>
      <div className="form-row">
        <label>
          模型（留空用 Claude 自己的默认设置）
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 sonnet、opus" />
        </label>
        <label>
          单次运行预算上限（美元）
          <input type="number" min={0.1} max={100} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
      </div>
      <div className="form-row">
        <label>
          同时运行的任务数（1 到 8）
          <input type="number" min={1} max={8} value={concurrent} onChange={(e) => setConcurrent(e.target.value)} />
        </label>
        <label>
          编辑器命令
          <input value={editor} onChange={(e) => setEditor(e.target.value)} placeholder="code" />
        </label>
      </div>
      <p className="muted small">预算是 claude 每次运行的花费上限，超过会自动停止，你可以调高后点「继续」。</p>
      <div className="form-actions">
        <span className="spacer" />
        <button
          className="btn btn-primary"
          onClick={() =>
            void act(() => api.saveSettings({ claudePath, model, maxBudgetUsd: Number(budget), maxConcurrent: Number(concurrent), editorCommand: editor })).then((r) => r && notify('设置已保存'))
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
            <span className={env?.git ? 'ok-dot' : 'bad-dot'} /> git：{env ? (env.git ?? '未找到') : '检测中…'}
          </li>
          <li>
            <span className={env?.gh ? 'ok-dot' : 'warn-dot'} /> gh（创建 PR 用）：{env ? (env.gh ?? '未找到；只影响「推送并创建 PR」') : '检测中…'}
          </li>
        </ul>
      </section>
      <GeneralSettings />
      <JiraSettings />
    </div>
  );
}
