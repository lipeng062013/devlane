import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * 本地服务能在你的电脑上运行命令，所以要防止你访问的其他网页悄悄调用它：
 * 1. Host 必须是本机地址 + 本服务端口（防 DNS 重绑定）；
 * 2. 写操作必须带自定义请求头（跨域请求带自定义头会触发预检，而我们不放行）；
 * 3. 写操作如果带了 Origin，必须是本机地址。
 */
export const CLIENT_HEADER = 'x-devlane';

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function buildGuard(port: number, extraOrigins: string[] = []) {
  const hosts = new Set(allowedHosts(port));
  const origins = new Set([...allowedHosts(port).map((h) => `http://${h}`), ...extraOrigins]);

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) {
      await reply.code(403).send({ error: '不允许的访问来源（Host）' });
      return;
    }
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return;

    if (req.headers[CLIENT_HEADER] !== '1') {
      await reply.code(403).send({ error: '缺少请求头，已拒绝' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
      await reply.code(403).send({ error: '不允许的请求来源（Origin）' });
    }
  };
}
