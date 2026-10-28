import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { ClaudeAgent } from './claude';
import { StateStore } from './store';
import { TaskManager } from './tasks';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(process.env.DEVLANE_HOME ?? join(homedir(), '.devlane'));
  const webDir = resolve(process.env.DEVLANE_WEB_DIR ?? join(here, 'web'));
  const port = Number(argValue('--port') ?? process.env.PORT ?? 7788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`端口不合法：${port}`);

  const store = new StateStore(join(dataDir, 'state.json'));
  const agent = new ClaudeAgent();
  const manager = new TaskManager({ store, agent, dataDir });
  const extraOrigins = (process.env.DEVLANE_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const app = buildApp({ store, manager, agent, port, webDir, extraOrigins, logger: false });

  try {
    // 只监听本机，这是安全模型的一部分，不提供修改入口
    await app.listen({ port, host: '127.0.0.1' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用。DevLane 可能已经在运行，或用 --port 换一个端口。`);
      process.exit(1);
    }
    throw err;
  }

  const url = `http://127.0.0.1:${port}`;
  console.log(`DevLane 已启动：${url}`);
  console.log(`数据目录：${dataDir}`);
  manager.pump();

  if (process.argv.includes('--open') && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  const shutdown = async (): Promise<void> => {
    manager.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
