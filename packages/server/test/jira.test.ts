import { describe, expect, it } from 'vitest';
import { JiraClient, mapJiraIssue } from '../src/jira';

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('mapJiraIssue', () => {
  it('把 ADF 描述转成 Markdown，并映射字段', () => {
    const issue = mapJiraIssue(
      {
        key: 'HOUSE-1',
        fields: {
          summary: '标题',
          description: adf('复现步骤：略'),
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
          duedate: '2026-12-01',
          reporter: { displayName: '张三' },
          assignee: null,
          components: [{ name: 'web' }, { name: '' }],
        },
      },
      'https://example.atlassian.net',
    );
    expect(issue).toMatchObject({
      id: 'HOUSE-1',
      source: 'jira',
      type: 'bug',
      typeName: 'Bug',
      title: '标题',
      markdown: '复现步骤：略',
      priority: 'High',
      dueDate: '2026-12-01',
      reporter: '张三',
      components: ['web'],
      url: 'https://example.atlassian.net/browse/HOUSE-1',
    });
    expect(issue.assignee).toBeUndefined();
  });

  it('缺字段时使用兜底值，不抛错', () => {
    const issue = mapJiraIssue({ key: 'X-1', fields: {} }, 'https://x');
    expect(issue).toMatchObject({ title: 'X-1', type: 'task', markdown: '', components: [] });
  });

  it('读取验收标准自定义字段，ADF 与纯文本都支持', () => {
    const fromAdf = mapJiraIssue({ key: 'X-1', fields: { customfield_1: adf('必须通过') } }, 'https://x', 'customfield_1');
    expect(fromAdf.acceptance).toBe('必须通过');
    const fromText = mapJiraIssue({ key: 'X-2', fields: { customfield_1: '纯文本' } }, 'https://x', 'customfield_1');
    expect(fromText.acceptance).toBe('纯文本');
  });

  it('Story 与 Epic 归为 story，其余归为 task', () => {
    const type = (name: string) => mapJiraIssue({ key: 'X-1', fields: { issuetype: { name } } }, 'https://x').type;
    expect(type('Story')).toBe('story');
    expect(type('Epic')).toBe('story');
    expect(type('Sub-task')).toBe('task');
  });
});

describe('JiraClient', () => {
  const base = { baseUrl: 'https://example.atlassian.net/', email: 'a@b.c', apiToken: 'tok' };

  it('带 Basic 认证头，并用 JQL 与字段列表请求', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const client = new JiraClient({
      ...base,
      acceptanceField: 'customfield_9',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return json({ isLast: true, issues: [] });
      }) as unknown as typeof fetch,
    });
    await client.searchIssues('project = HOUSE');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('a@b.c:tok').toString('base64')}`);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://example.atlassian.net/rest/api/3/search/jql');
    expect(url.searchParams.get('jql')).toBe('project = HOUSE');
    expect(url.searchParams.get('fields')).toContain('customfield_9');
  });

  it('沿 nextPageToken 翻页直到最后一页', async () => {
    const tokens: Array<string | null> = [];
    const client = new JiraClient({
      ...base,
      fetchImpl: (async (url: string) => {
        const token = new URL(url).searchParams.get('nextPageToken');
        tokens.push(token);
        if (!token) return json({ issues: [{ key: 'A-1', fields: {} }], nextPageToken: 'p2', isLast: false });
        return json({ issues: [{ key: 'A-2', fields: {} }], isLast: true });
      }) as unknown as typeof fetch,
    });
    const issues = await client.searchIssues('x');
    expect(issues.map((i) => i.key)).toEqual(['A-1', 'A-2']);
    expect(tokens).toEqual([null, 'p2']);
  });

  it('达到 limit 后不再继续翻页', async () => {
    let calls = 0;
    const client = new JiraClient({
      ...base,
      fetchImpl: (async () => {
        calls += 1;
        return json({ issues: [{ key: `A-${calls}`, fields: {} }], nextPageToken: 'more', isLast: false });
      }) as unknown as typeof fetch,
    });
    const issues = await client.searchIssues('x', 2);
    expect(issues).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('遇到 429 按 Retry-After 等待后重试', async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = new JiraClient({
      ...base,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return json({}, 429, { 'retry-after': '3' });
        return json({ isLast: true, issues: [{ key: 'A-1', fields: {} }] });
      }) as unknown as typeof fetch,
    });
    const issues = await client.searchIssues('x');
    expect(issues).toHaveLength(1);
    expect(waits).toEqual([3000]);
  });

  it('429 超过重试次数后抛错', async () => {
    const client = new JiraClient({
      ...base,
      maxRetries: 2,
      sleep: async () => {},
      fetchImpl: (async () => json({}, 429)) as unknown as typeof fetch,
    });
    await expect(client.searchIssues('x')).rejects.toThrow('HTTP 429');
  });

  it('非 2xx 响应抛出带状态码的错误，且错误信息不含凭据', async () => {
    const client = new JiraClient({
      ...base,
      fetchImpl: (async () => json({ message: 'nope' }, 401)) as unknown as typeof fetch,
    });
    const err = await client.searchIssues('x').catch((e: Error) => e);
    expect((err as Error).message).toBe('Jira 请求失败: HTTP 401');
    expect((err as Error).message).not.toContain('tok');
  });
});
