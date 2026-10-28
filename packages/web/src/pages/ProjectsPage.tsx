import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { Project, RepoInfo } from '../types';

function ProjectForm({
  initial,
  info,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial: { name: string; baseBranch: string; testCommand: string; extraAllowed: string; linkNodeModules: boolean };
  info?: RepoInfo;
  onSubmit: (v: { name: string; baseBranch: string; testCommand: string; extraAllowed: string[]; linkNodeModules: boolean }) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial.name);
  const [baseBranch, setBaseBranch] = useState(initial.baseBranch);
  const [testCommand, setTestCommand] = useState(initial.testCommand);
  const [extra, setExtra] = useState(initial.extraAllowed);
  const [link, setLink] = useState(initial.linkNodeModules);
  const [busy, setBusy] = useState(false);
  const branches = info ? [...new Set(info.branches.filter((b) => !b.includes('/')).concat(info.suggestedBase))] : null;

  return (
    <form
      className="project-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSubmit({
          name,
          baseBranch,
          testCommand,
          extraAllowed: extra.split('\n').map((s) => s.trim()).filter(Boolean),
          linkNodeModules: link,
        }).finally(() => setBusy(false));
      }}
    >
      <div className="form-row">
        <label>
          项目名称
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          基线分支（任务从它拉出）
          {branches ? (
            <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
              {branches.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          ) : (
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          )}
        </label>
      </div>
      <label>
        测试命令（改完后用它验证，也允许 Claude 运行）
        <input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="例如 npm test、pytest -q、go test ./..." className="mono" />
      </label>
      <label>
        额外允许 Claude 运行的命令（每行一条，不含 && | ; 等符号）
        <textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={'npm run lint\nnpm run build'} className="mono" />
      </label>
      <label className="check">
        <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
        把主仓库的 node_modules 链接进任务工作区（省去重新安装；仅在它已被 .gitignore 忽略时生效）
      </label>
      <div className="form-actions">
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function AddProject({ onDone }: { onDone: () => void }) {
  const { act } = useApp();
  const [path, setPath] = useState('');
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function check(): Promise<void> {
    setChecking(true);
    setError(null);
    setInfo(null);
    try {
      setInfo(await api.inspectRepo(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  const folder = info ? (info.root.split(/[\\/]/).filter(Boolean).pop() ?? '') : '';

  return (
    <div className="card">
      <h3>添加本地项目</h3>
      <form
        className="path-row"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="项目的完整路径，例如 D:\code\my-app" className="mono" autoFocus />
        <button className="btn btn-primary" disabled={checking || !path.trim()}>
          {checking ? '检查中…' : '检查'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          取消
        </button>
      </form>
      {error && <div className="notice-inline bad">{error}</div>}
      {info && (
        <div className="repo-info">
          <div className="repo-facts">
            <div>
              仓库根目录：<span className="mono">{info.root}</span>
            </div>
            <div>
              当前分支：<b>{info.currentBranch ?? '（游离 HEAD）'}</b>　推荐基线：<b>{info.suggestedBase}</b>
            </div>
            <div>远程：{info.remotes.length ? info.remotes.join('、') : <span className="bad-text">没有（只能本地提交，不能推送和开 PR）</span>}</div>
            {!info.hasCommits && <div className="bad-text">这个仓库还没有任何提交，需要先做一次初始提交。</div>}
            {info.dirty && (
              <div className="warn-text">
                主工作目录有 {info.dirtyCount} 处未提交的改动。没关系，DevLane 不会动它，但任务是从已提交的 {info.suggestedBase} 拉出来的，不包含这些改动。
              </div>
            )}
          </div>
          {info.hasCommits && (
            <ProjectForm
              initial={{ name: folder, baseBranch: info.suggestedBase, testCommand: '', extraAllowed: '', linkNodeModules: true }}
              info={info}
              submitLabel="添加项目"
              onCancel={onDone}
              onSubmit={async (v) => {
                const ok = await act(() => api.addProject({ path: info.root, ...v }));
                if (ok) onDone();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const { state, act } = useApp();
  const [editing, setEditing] = useState(false);
  const live = state.tasks.filter((t) => t.projectId === project.id && t.status !== 'discarded').length;

  return (
    <div className="card">
      <div className="card-head">
        <h3>{project.name}</h3>
        <span className="muted small">{live} 个任务</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setEditing(!editing)}>
          {editing ? '收起' : '编辑'}
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => {
            if (window.confirm(`移除项目「${project.name}」？只会从 DevLane 里移除，不会删除你的代码。`)) void act(() => api.deleteProject(project.id));
          }}
        >
          移除
        </button>
      </div>
      <div className="mono small">{project.path}</div>
      <div className="muted small">
        基线 {project.baseBranch} · 测试：{project.testCommand ? <span className="mono">{project.testCommand}</span> : '未配置'} · {project.linkNodeModules ? '链接 node_modules' : '不链接 node_modules'}
      </div>
      {editing && (
        <ProjectForm
          initial={{ name: project.name, baseBranch: project.baseBranch, testCommand: project.testCommand, extraAllowed: project.extraAllowed.join('\n'), linkNodeModules: project.linkNodeModules }}
          submitLabel="保存"
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => {
            const ok = await act(() => api.updateProject(project.id, v));
            if (ok) setEditing(false);
          }}
        />
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const { state } = useApp();
  const [adding, setAdding] = useState(state.projects.length === 0);

  return (
    <div className="page-pad">
      <div className="pane-head">
        <h1>项目</h1>
        <span className="spacer" />
        {!adding && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            添加项目
          </button>
        )}
      </div>
      <p className="muted">项目就是你电脑上的一个 git 仓库。每个任务会从它的基线分支拉出独立的工作区，改动不会碰到你当前的工作目录。</p>
      {adding && <AddProject onDone={() => setAdding(false)} />}
      {state.projects.map((p) => (
        <ProjectCard key={p.id} project={p} />
      ))}
    </div>
  );
}
