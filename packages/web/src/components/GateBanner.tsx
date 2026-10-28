import type { Gate, Lane } from '../types';

interface Props {
  gates: Gate[];
  lanes: Lane[];
  onResolve: (gateId: string, decision: 'approve' | 'reject') => void;
  onOpenLane: (laneId: string) => void;
}

const GATE_TYPE_LABEL: Record<string, string> = {
  high_risk_file: '高风险文件',
  scope_change: '超出声明范围',
};

export default function GateBanner({ gates, lanes, onResolve, onOpenLane }: Props) {
  const open = gates.filter((g) => g.status === 'open');
  if (open.length === 0) return null;
  return (
    <section className="gate-banner" aria-label="待处理门禁">
      <div className="gate-banner-title">需要你处理 · {open.length} 个门禁</div>
      {open.map((gate) => {
        const lane = lanes.find((l) => l.id === gate.laneId);
        return (
          <div className="gate-item" key={gate.id}>
            <div className="gate-text">
              <button className="link" onClick={() => onOpenLane(gate.laneId)}>
                {lane ? `${lane.issueKey} ${lane.title}` : gate.laneId}
              </button>
              <span className="chip chip-gate">{GATE_TYPE_LABEL[gate.gateType] ?? gate.gateType}</span>
              <span className="gate-reason">{gate.reason}</span>
            </div>
            <div className="gate-actions">
              <button className="btn btn-primary btn-sm" onClick={() => onResolve(gate.id, 'approve')}>
                批准
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => onResolve(gate.id, 'reject')}>
                拒绝
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
