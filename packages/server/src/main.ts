import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventService } from '@devlane/event-service';
import { buildApp } from './app';
import { SimulatedExecutor } from './executor';
import { JiraClient } from './jira';
import { Orchestrator } from './orchestrator';
import { seedDemoIssues } from './seed';
import { StateStore } from './store';

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(process.env.DEVLANE_DATA_DIR ?? join(process.cwd(), 'data'));
  const webDir = resolve(process.env.DEVLANE_WEB_DIR ?? join(here, 'web'));
  const port = intEnv('PORT', 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const tickMs = intEnv('DEVLANE_TICK_MS', 2500);
  const maxParallel = intEnv('DEVLANE_MAX_PARALLEL', 3);

  let password = process.env.DEVLANE_PASSWORD;
  if (!password) {
    password = randomBytes(9).toString('base64url');
    console.warn(`[devlane] 未设置 DEVLANE_PASSWORD，本次启动使用临时口令: ${password}`);
  }

  const store = new StateStore(join(dataDir, 'state.json'));
  const events = new EventService({ dbPath: join(dataDir, 'events.db') });
  const orchestrator = new Orchestrator({ store, events, executor: new SimulatedExecutor(), maxParallel });

  if (store.data.issues.length === 0 && process.env.DEVLANE_SEED_DEMO !== '0') {
    await seedDemoIssues(orchestrator);
  }

  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_ACCEPTANCE_FIELD, JIRA_DEFAULT_JQL } = process.env;
  const jira =
    JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN
      ? new JiraClient({
          baseUrl: JIRA_BASE_URL,
          email: JIRA_EMAIL,
          apiToken: JIRA_API_TOKEN,
          acceptanceField: JIRA_ACCEPTANCE_FIELD,
        })
      : null;

  const app = buildApp({
    orchestrator,
    password,
    webDir,
    jira,
    jiraJql: JIRA_DEFAULT_JQL ?? 'statusCategory != Done ORDER BY created DESC',
    tickMs,
    maxParallel,
    logger: true,
  });

  orchestrator.start(tickMs);

  const shutdown = async (): Promise<void> => {
    orchestrator.stop();
    await app.close();
    events.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port, host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
