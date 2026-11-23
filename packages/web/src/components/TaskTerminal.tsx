import { useEffect, useRef, useState } from 'react';
import { clock } from '../util';
import type { TimelineItem } from '../types';

/** 同一条时间线的终端视图。输入由外层发送，进入同一个会话队列。 */
export default function TaskTerminal({
  items,
  running,
  agentName,
  queued,
}: {
  items: TimelineItem[];
  running: boolean;
  agentName: string;
  queued: boolean;
}) {
  const box = useRef<HTMLPreElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (stick && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items, running, stick]);

  const lines = items.map(renderLine).filter(Boolean);

  return (
    <div className="task-terminal">
      <pre
        ref={box}
        className="task-terminal-screen"
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {lines.join('\n')}
        {lines.length === 0 && '会话还没有输出。'}
        {running && `\n\n${agentName} 正在工作…`}
        {queued && `\n有一条消息在队列里，当前这轮结束后会在同一会话里发出。`}
      </pre>
    </div>
  );
}

function renderLine(item: TimelineItem): string {
  const at = clock(item.ts);
  if (item.type === 'note') return `${at}  ${item.text}`;
  if (item.type === 'prompt') return `${at}  › ${oneLine(item.text)}`;
  if (item.type === 'text') return item.text;
  if (item.type === 'tool') return `${at}  ${item.name}  ${oneLine(item.summary)}`;
  if (item.type === 'tool_result') return `${at}  ${item.ok ? '完成' : '失败'}  ${oneLine(item.text)}`;
  if (item.type === 'result') return `${at}  ${item.ok ? '这一轮完成' : '这一轮未完成'}  ${item.turns} 轮`;
  if (item.type === 'denied') return `${at}  拦截  ${item.tool}  ${oneLine(item.summary)}`;
  return '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 240);
}
