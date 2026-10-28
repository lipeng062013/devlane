import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/domain';
import { JiraClient, buildJql, normalizeBaseUrl } from '../src/jira';

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const cfg = { baseUrl: 'https://house730.atlassian.net', email: 'me@example.com', apiToken: 'secret-token' };

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, extra: object = {}) {
  return new JiraClient({ ...cfg, sleep: async () => undefined, fetchImpl: handler as unknown as typeof fetch, ...extra });
}

describe('normalizeBaseUrl', () => {
  it('只保留协议和主机', () => {
    expect(normalizeBaseUrl(' https://house730.atlassian.net/jira/software/projects/X ')).toBe('https://house730.atlassian.net');
    expect(normalizeBaseUrl('http://jira.local:8080/')).toBe('http://jira.local:8080');
  });

  it('拒绝格式错误、非 http 协议、带账号密码的地址', () => {
    for (const bad of ['', 'house730', 'ftp://x.com', 'javascript:alert(1)', 'https://user:pw@x.atlassian.net']) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(HttpError);
    }
  });
});

describe('buildJql', () => {
  it('默认：指派给我且未完成，按更新时间倒序', () => {
    expect(buildJql({})).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  });

  it('其他范围', () => {
    expect(buildJql({ scope: 'reported' })).toContain('reporter = currentUser()');
    expect(buildJql({ scope: 'recent' })).toContain('updated >= -30d');
  });

  it('编号直接按 key 查，文本走 text 搜索', () => {
    expect(buildJql({ q: 'abc-12' })).toContain('key = "ABC-12"');
    expect(buildJql({ q: '登录失败' })).toContain('text ~ "登录失败"');
  });

  it('搜索词里的引号和反斜杠被转义，不能注入额外条件', () => {
    const jql = buildJql({ q: 'x" OR project = SECRET OR text ~ "y\\' });
    expect(jql).toContain('text ~ "x\\" OR project = SECRET OR text ~ \\"y\\\\"');
    // 去掉转义序列后，只应剩下包围搜索词的那一对引号
    expect(jql.replace(/\\./g, '').match(/"/g)).toHaveLength(2);
  });

  it('搜索词过长会被截断', () => {
    expect(buildJql({ q: 'a'.repeat(500) }).length).toBeLessThan(300);
  });
});

describe('JiraClient', () => {
  it('带 Basic 认证头访问站点', async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const c = client((url, init) => {
      seen = { url, auth: new Headers(init?.headers).get('authorization') };
      return json({ displayName: '李明', emailAddress: 'me@example.com' });
    });
    const me = await c.myself();
    expect(me).toEqual({ name: '李明', email: 'me@example.com' });
    expect(seen!.url).toBe('https://house730.atlassian.net/rest/api/3/myself');
    expect(seen!.auth).toBe(`Basic ${Buffer.from('me@example.com:secret-token').toString('base64')}`);
  });

  it('列表：映射字段，返回下一页令牌', async () => {
    let requested = '';
    const c = client((url) => {
      requested = url;
      return json({
        issues: [
          {
            key: 'HOUSE-7',
            fields: {
              summary: '登录页按钮无响应',
              issuetype: { name: 'Bug' },
              status: { name: '处理中', statusCategory: { key: 'indeterminate' } },
              priority: { name: 'High' },
              assignee: { displayName: '李明' },
              updated: '2026-10-28T08:00:00.000+0800',
            },
          },
          { key: 'HOUSE-8', fields: {} },
        ],
        nextPageToken: 'tok2',
        isLast: false,
      });
    });
    const r = await c.search('project = HOUSE', { limit: 10, pageToken: 'tok1' });
    const url = new URL(requested);
    expect(url.pathname).toBe('/rest/api/3/search/jql');
    expect(url.searchParams.get('jql')).toBe('project = HOUSE');
    expect(url.searchParams.get('maxResults')).toBe('10');
    expect(url.searchParams.get('nextPageToken')).toBe('tok1');
    expect(r.nextPageToken).toBe('tok2');
    expect(r.issues[0]).toMatchObject({
      key: 'HOUSE-7',
      summary: '登录页按钮无响应',
      type: 'Bug',
      status: '处理中',
      statusCategory: 'indeterminate',
      priority: 'High',
      assignee: '李明',
      url: 'https://house730.atlassian.net/browse/HOUSE-7',
    });
    expect(r.issues[1]).toMatchObject({ key: 'HOUSE-8', summary: 'HOUSE-8', type: 'Task' });
  });

  it('最后一页没有令牌', async () => {
    const c = client(() => json({ issues: [], isLast: true, nextPageToken: 'ignored' }));
    expect((await c.search('x')).nextPageToken).toBeUndefined();
  });

  it('单页数量上限 100', async () => {
    let n = '';
    const c = client((url) => {
      n = new URL(url).searchParams.get('maxResults')!;
      return json({ issues: [], isLast: true });
    });
    await c.search('x', { limit: 5000 });
    expect(n).toBe('100');
  });

  it('详情：ADF 描述转 Markdown，评论只取最近 5 条', async () => {
    const comments = Array.from({ length: 7 }, (_, i) => ({
      author: { displayName: `人${i}` },
      created: '2026-10-28T00:00:00.000Z',
      body: adf(`评论${i}`),
    }));
    const c = client(() =>
      json({
        key: 'HOUSE-7',
        fields: {
          summary: 's',
          description: adf('复现步骤：点击按钮'),
          reporter: { displayName: '王芳' },
          labels: ['web'],
          components: [{ name: 'login' }],
          comment: { comments },
        },
      }),
    );
    const d = await c.get('house-7');
    expect(d.description).toBe('复现步骤：点击按钮');
    expect(d.reporter).toBe('王芳');
    expect(d.labels).toEqual(['web']);
    expect(d.components).toEqual(['login']);
    expect(d.comments).toHaveLength(5);
    expect(d.comments[0]!.body).toBe('评论2');
  });

  it('详情：编号格式不对时在请求之前就拒绝', async () => {
    let called = false;
    const c = client(() => {
      called = true;
      return json({});
    });
    for (const bad of ['../../etc', 'HOUSE-7/../x', 'abc', 'HOUSE-', '']) {
      await expect(c.get(bad), bad).rejects.toThrow('编号格式不对');
    }
    expect(called).toBe(false);
  });

  it('429 按 Retry-After 等待后重试', async () => {
    let calls = 0;
    const waits: number[] = [];
    const c = client(
      () => (++calls === 1 ? json({}, 429, { 'retry-after': '3' }) : json({ displayName: 'x' })),
      { sleep: async (ms: number) => void waits.push(ms) },
    );
    await c.myself();
    expect(waits).toEqual([3000]);
  });

  it('429 超过重试次数后报错', async () => {
    const c = client(() => json({}, 429), { maxRetries: 2 });
    await expect(c.myself()).rejects.toBeInstanceOf(HttpError);
  });

  it.each([
    [401, '认证失败'],
    [403, '拒绝访问'],
    [404, '找不到'],
  ])('HTTP %i 给出可读的中文原因', async (status, text) => {
    const c = client(() => json({}, status));
    await expect(c.myself()).rejects.toThrow(text);
  });

  it('JQL 有误时带上 Jira 的原因，状态码 400', async () => {
    const c = client(() => json({ errorMessages: ['Field "foo" does not exist'] }, 400));
    const err = await c.search('foo = 1').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toContain('does not exist');
  });

  it('网络错误给出可读提示，且不泄露 Token', async () => {
    const c = client(() => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const err = (await c.myself().catch((e: unknown) => e)) as HttpError;
    expect(err.message).toContain('连不上 Jira');
    expect(err.message).not.toContain('secret-token');
  });
});
