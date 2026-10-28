import { adfToMarkdown, type AdfNode } from '@devlane/adf';
import { HttpError } from './domain';

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** 遇到 429 时的最大重试次数，默认 3。 */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  type: string;
  status: string;
  /** new / indeterminate / done */
  statusCategory: string;
  priority?: string;
  assignee?: string;
  updated: string;
  url: string;
}

export interface JiraComment {
  author: string;
  created: string;
  body: string;
}

export interface JiraIssueDetail extends JiraIssueSummary {
  description: string;
  reporter?: string;
  labels: string[];
  components: string[];
  comments: JiraComment[];
}

export interface JiraSearchResult {
  issues: JiraIssueSummary[];
  nextPageToken?: string;
}

/** 路由层依赖的接口，测试时可以替换。 */
export interface JiraApi {
  myself(): Promise<{ name: string; email?: string }>;
  search(jql: string, opts?: { limit?: number; pageToken?: string }): Promise<JiraSearchResult>;
  get(key: string): Promise<JiraIssueDetail>;
}

export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** 规范化站点地址：只保留协议和主机，拒绝带账号密码的地址。 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Jira 地址格式不对，应类似 https://your-team.atlassian.net');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Jira 地址必须以 https:// 开头');
  if (url.username || url.password) throw new HttpError(400, 'Jira 地址里不要包含账号或密码');
  return `${url.protocol}//${url.host}`;
}

export type JiraScope = 'mine' | 'reported' | 'recent';

function escapeJqlText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 把界面上的范围和搜索词拼成 JQL。 */
export function buildJql(opts: { scope?: JiraScope; q?: string }): string {
  const clauses: string[] = [];
  switch (opts.scope ?? 'mine') {
    case 'reported':
      clauses.push('reporter = currentUser() AND statusCategory != Done');
      break;
    case 'recent':
      clauses.push('updated >= -30d');
      break;
    default:
      clauses.push('assignee = currentUser() AND statusCategory != Done');
  }
  const q = (opts.q ?? '').trim().slice(0, 100);
  if (q) {
    if (ISSUE_KEY.test(q)) clauses.push(`key = "${q.toUpperCase()}"`);
    else clauses.push(`text ~ "${escapeJqlText(q)}"`);
  }
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    labels?: string[];
    components?: Array<{ name?: string }>;
    updated?: string;
    comment?: { comments?: Array<{ author?: { displayName?: string }; created?: string; body?: AdfNode | string }> };
  };
}

function toMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return adfToMarkdown(value as AdfNode).markdown;
  return '';
}

function summarize(raw: RawIssue, baseUrl: string): JiraIssueSummary {
  const f = raw.fields;
  return {
    key: raw.key,
    summary: f.summary ?? raw.key,
    type: f.issuetype?.name ?? 'Task',
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? '',
    priority: f.priority?.name ?? undefined,
    assignee: f.assignee?.displayName ?? undefined,
    updated: f.updated ?? '',
    url: `${baseUrl}/browse/${raw.key}`,
  };
}

export class JiraClient implements JiraApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: JiraConfig) {
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async getJson<T>(path: string): Promise<T> {
    const auth = `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64')}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new HttpError(502, `连不上 Jira（${this.baseUrl}）：${(err as Error).message}`);
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
        await this.sleep(Math.min(wait, 30_000));
        continue;
      }
      if (res.ok) return (await res.json()) as T;

      if (res.status === 401) throw new HttpError(502, 'Jira 认证失败（401）：请检查邮箱和 API Token');
      if (res.status === 403) throw new HttpError(502, 'Jira 拒绝访问（403）：这个账号没有权限');
      if (res.status === 404) throw new HttpError(404, 'Jira 里找不到这条记录或接口（404）');
      const body = (await res.json().catch(() => null)) as { errorMessages?: string[] } | null;
      const reason = body?.errorMessages?.[0];
      throw new HttpError(res.status === 400 ? 400 : 502, `Jira 请求失败（HTTP ${res.status}）${reason ? `：${reason}` : ''}`);
    }
  }

  async myself(): Promise<{ name: string; email?: string }> {
    const me = await this.getJson<{ displayName?: string; emailAddress?: string }>('/rest/api/3/myself');
    return { name: me.displayName ?? this.cfg.email, email: me.emailAddress };
  }

  async search(jql: string, opts: { limit?: number; pageToken?: string } = {}): Promise<JiraSearchResult> {
    const query = new URLSearchParams({
      jql,
      fields: 'summary,issuetype,status,priority,assignee,updated',
      maxResults: String(Math.min(opts.limit ?? 30, 100)),
    });
    if (opts.pageToken) query.set('nextPageToken', opts.pageToken);
    const page = await this.getJson<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
      `/rest/api/3/search/jql?${query.toString()}`,
    );
    return {
      issues: (page.issues ?? []).map((raw) => summarize(raw, this.baseUrl)),
      nextPageToken: page.isLast ? undefined : page.nextPageToken,
    };
  }

  async get(key: string): Promise<JiraIssueDetail> {
    if (!ISSUE_KEY.test(key)) throw new HttpError(400, `Jira 编号格式不对：${key}`);
    const fields = 'summary,description,issuetype,status,priority,assignee,reporter,labels,components,updated,comment';
    const raw = await this.getJson<RawIssue>(`/rest/api/3/issue/${encodeURIComponent(key.toUpperCase())}?fields=${fields}`);
    const f = raw.fields;
    return {
      ...summarize(raw, this.baseUrl),
      description: toMarkdown(f.description).trim(),
      reporter: f.reporter?.displayName ?? undefined,
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name ?? '').filter(Boolean),
      comments: (f.comment?.comments ?? []).slice(-5).map((c) => ({
        author: c.author?.displayName ?? '',
        created: c.created ?? '',
        body: toMarkdown(c.body).trim(),
      })),
    };
  }
}
