import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { appendEvent, verifyChain, type LaneEvent, type NewEvent } from '@devlane/event-schema';

export interface EventServiceConfig {
  /** 指定后，数据库在每次追加后写回该文件，重启时从该文件恢复；不指定则只在内存中。 */
  dbPath?: string;
}

export class EventService {
  private db: Database | null = null;
  private ready: Promise<void>;
  private readonly dbPath: string | undefined;

  constructor(config: EventServiceConfig = {}) {
    this.dbPath = config.dbPath;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();
    this.db =
      this.dbPath && existsSync(this.dbPath)
        ? new SQL.Database(readFileSync(this.dbPath))
        : new SQL.Database();
    this.initSchema();
  }

  /** 先写临时文件再改名，避免进程在写入中途退出时留下损坏的数据库。 */
  private persist(): void {
    if (!this.dbPath) return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, this.db!.export());
    renameSync(tmp, this.dbPath);
  }

  async listLaneIds(): Promise<string[]> {
    await this.ready;
    const result = this.db!.exec(`SELECT DISTINCT lane_id FROM lane_event ORDER BY lane_id`);
    if (result.length === 0) return [];
    return result[0]!.values.map((row) => String(row[0]));
  }

  private initSchema(): void {
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS lane_event (
        id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL,
        run_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload TEXT NOT NULL,
        parent_ids TEXT NOT NULL,
        artifact_ids TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        UNIQUE (lane_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_lane_seq ON lane_event(lane_id, seq);
      CREATE INDEX IF NOT EXISTS idx_type_ts ON lane_event(type, ts);
    `);
  }

  async append(input: NewEvent): Promise<LaneEvent> {
    await this.ready;
    const last = await this.getLast(input.laneId);
    const event = appendEvent(last, input);
    
    this.db!.run(
      `INSERT INTO lane_event (id, lane_id, run_id, seq, type, actor, ts, payload, parent_ids, artifact_ids, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.laneId,
        event.runId,
        event.seq,
        event.type,
        JSON.stringify(event.actor),
        event.ts,
        JSON.stringify(event.payload),
        JSON.stringify(event.parentIds),
        JSON.stringify(event.artifactIds),
        event.prevHash,
      ],
    );
    this.persist();

    return event;
  }

  async getLast(laneId: string): Promise<LaneEvent | null> {
    await this.ready;
    const result = this.db!.exec(`SELECT * FROM lane_event WHERE lane_id = ? ORDER BY seq DESC LIMIT 1`, [laneId]);
    if (result.length === 0 || result[0]!.values.length === 0) return null;
    return this.rowToEvent(result[0]!.columns, result[0]!.values[0]!);
  }

  async list(laneId: string, afterSeq = 0, limit = 50): Promise<LaneEvent[]> {
    await this.ready;
    const result = this.db!.exec(
      `SELECT * FROM lane_event WHERE lane_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      [laneId, afterSeq, limit],
    );
    if (result.length === 0) return [];
    return result[0]!.values.map((row) => this.rowToEvent(result[0]!.columns, row));
  }

  async verifyLane(laneId: string): Promise<{ ok: boolean; brokenAtSeq?: number; reason?: string }> {
    const events = await this.list(laneId, 0, 10000);
    return verifyChain(events);
  }

  private rowToEvent(columns: string[], values: SqlValue[]): LaneEvent {
    const obj = Object.fromEntries(columns.map((col, i) => [col, values[i]]));
    return {
      id: String(obj.id ?? ''),
      laneId: String(obj.lane_id ?? ''),
      runId: obj.run_id ? String(obj.run_id) : null,
      seq: Number(obj.seq ?? 0),
      type: String(obj.type ?? '') as any,
      actor: JSON.parse(String(obj.actor ?? '{}')),
      ts: String(obj.ts ?? ''),
      payload: JSON.parse(String(obj.payload ?? '{}')),
      parentIds: JSON.parse(String(obj.parent_ids ?? '[]')),
      artifactIds: JSON.parse(String(obj.artifact_ids ?? '[]')),
      prevHash: String(obj.prev_hash ?? ''),
    };
  }

  close(): void {
    this.db?.close();
  }
}
