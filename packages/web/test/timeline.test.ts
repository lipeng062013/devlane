import { describe, expect, it } from 'vitest';
import { groupTimeline } from '../src/components/Timeline';
import type { TimelineItem } from '../src/types';

function text(seq: number, value: string): TimelineItem {
  return { seq, ts: 't', type: 'text', text: value };
}

describe('groupTimeline', () => {
  it('把连续文字合成一条，工具仍单独成行', () => {
    const tool: TimelineItem = { seq: 3, ts: 't', type: 'tool', toolUseId: 'a', name: 'Read', summary: 'a.ts', detail: '' };
    const grouped = groupTimeline([text(1, '我'), text(2, '先'), tool, text(4, '读取')]);
    expect(grouped.map((item) => (item.type === 'text' ? item.text : item.type))).toEqual(['我先', 'tool', '读取']);
  });
});
