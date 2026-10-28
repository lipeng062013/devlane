import { adfToMarkdown, type AdfNode } from '@devlane/adf';
import { normalizeIssueType, type Issue } from './domain';

export interface JiraConfig {
  /** 站点地址，如 https://example.atlassian.net，末尾斜杠会被去掉。 */
  baseUrl: string;
  email: string;
  apiToken: string;
  /** 验收标准所在的自定义字段 id，如 customfield_10100。未配置则只从描述里找。 */
  acceptanceField?: string;
  fetchImpl?: typeof fetch;
  /** 遇到 429 时的最大重试次数，默认 3。 */
  maxRetries?: number;
  /** 重试等待，测试里可注入为立即返回。 */
  sleep?: (ms: number) => Promise<void>;
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    duedate?: string | null;
    reporter?: { displayName?: string } | null;
    assignee?: { displayName?: string } | null;
    components?: Array<{ name?: string }>;
    [custom: string]: unknown;
  };
}

interface SearchResponse {
  issues?: RawIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return adfToMarkdown(value as AdfNode).markdown;
  return '';
}

export function mapJiraIssue(raw: RawIssue, baseUrl: string, acceptanceField?: string): Issue {
  const f = raw.fields;
  const typeName = f.issuetype?.name ?? 'Task';
  const acceptance = acceptanceField ? textOf(f[acceptanceField]).trim() : '';
  return {
    id: raw.key,
    key: raw.key,
    source: 'jira',
    type: normalizeIssueType(typeName),
    typeName,
    title: f.summary ?? raw.key,
    markdown: textOf(f.description).trim(),
    acceptance: acceptance || undefined,
    priority: f.priority?.name ?? undefined,
    dueDate: f.duedate ?? undefined,
    reporter: f.reporter?.displayName ?? undefined,
    assignee: f.assignee?.displayName ?? undefined,
    components: (f.components ?? []).map((c) => c.name ?? '').filter(Boolean),
    url: `${baseUrl}/browse/${raw.key}`,
    createdAt: new Date().toISOString(),
  };
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: JiraConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64')}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Authorization: this.authHeader(), Accept: 'application/json' },
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
        await this.sleep(Math.min(wait, 30_000));
        continue;
      }
      if (!res.ok) throw new Error(`Jira 请求失败: HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  /** 按 JQL 查询，沿 nextPageToken 翻页，直到取满 limit 条或没有下一页。 */
  async searchIssues(jql: string, limit = 100): Promise<Issue[]> {
    const fields = [
      'summary',
      'description',
      'issuetype',
      'priority',
      'duedate',
      'reporter',
      'assignee',
      'components',
      ...(this.cfg.acceptanceField ? [this.cfg.acceptanceField] : []),
    ].join(',');

    const out: Issue[] = [];
    let token: string | undefined;
    do {
      const pageSize = Math.min(50, limit - out.length);
      const query = new URLSearchParams({ jql, fields, maxResults: String(pageSize) });
      if (token) query.set('nextPageToken', token);
      const page = await this.getJson<SearchResponse>(`/rest/api/3/search/jql?${query.toString()}`);
      for (const raw of page.issues ?? []) {
        out.push(mapJiraIssue(raw, this.baseUrl, this.cfg.acceptanceField));
      }
      token = page.isLast ? undefined : page.nextPageToken;
    } while (token && out.length < limit);
    return out;
  }
}
