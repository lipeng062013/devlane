import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { Capability, CapabilityScope } from '../types';

const SCOPE_LABEL: Record<CapabilityScope, string> = {
  project: '项目',
  user: '个人',
  machine: '本机',
};

export default function CapabilityPanel() {
  const { state } = useApp();
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? '');
  const [items, setItems] = useState<Capability[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    void api.capabilities(projectId).then((res) => {
      if (!cancelled) setItems(res.items);
    }).catch(() => {
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const skills = items?.filter((item) => item.kind === 'skill') ?? [];
  const mcps = items?.filter((item) => item.kind === 'mcp') ?? [];

  return (
    <section className="card capability-panel">
      <h3>Skill 与 MCP</h3>
      <p className="muted small">这是本机已经配好的 skill 和 MCP，按项目、个人、本机分档。Agent 启动时读取自己的配置，不会把这一整份清单塞进提示词。</p>
      {state.projects.length > 1 && (
        <label>
          项目
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {items === null && <p className="muted small">正在读取本机配置…</p>}
      {items && items.length === 0 && <p className="muted small">没有读到 skill 或 MCP。</p>}
      {items && items.length > 0 && (
        <div className="capability-grid">
          <CapabilityGroup title={`Skill · ${skills.length}`} items={skills} />
          <CapabilityGroup title={`MCP · ${mcps.length}`} items={mcps} />
        </div>
      )}
    </section>
  );
}

function CapabilityGroup({ title, items }: { title: string; items: Capability[] }) {
  return (
    <div>
      <h4>{title}</h4>
      <ul className="capability-list capability-list-settings">
        {items.map((item) => (
          <li key={`${item.kind}:${item.name}`}>
            <span className={`chip chip-scope chip-${item.scope}`}>{SCOPE_LABEL[item.scope]}</span>
            <span>{item.name}</span>
            <span className="muted small">{item.source}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
