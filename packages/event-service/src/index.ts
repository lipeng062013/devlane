import Database from 'better-sqlite3';
import { appendEvent, hashEvent, verifyChain, type LaneEvent, type NewEvent } from '@devlane/event-schema';

export interface EventServiceConfig {
  dbPath: string;
}

export class EventService {
  private db: Database.Database;

  constructor(config: EventServiceConfig) {
    this.db = new Database(config.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
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

  /** 在指定 lane 的最后一个事件之后追加新事件，返回完整事件。 */
  append(input: NewEvent): LaneEvent {
    const last = this.getLast(input.laneId);
    const event = appendEvent(last, input);
    
    const stmt = this.db.prepare(`
      INSERT INTO lane_event (id, lane_id, run_id, seq, type, actor, ts, payload, parent_ids, artifact_ids, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
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
    );
    
    return event;
  }

  /** 获取指定 lane 的最后一个事件，没有则返回 null。 */
  getLast(laneId: string): LaneEvent | null {
    const stmt = this.db.prepare(`
      SELECT * FROM lane_event WHERE lane_id = ? ORDER BY seq DESC LIMIT 1
    `);
    const row = stmt.get(laneId) as any;
    return row ? this.rowToEvent(row) : null;
  }

  /** 分页获取指定 lane 的事件，afterSeq 为上次最后一个事件的 seq。 */
  list(laneId: string, afterSeq = 0, limit = 50): LaneEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM lane_event WHERE lane_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `);
    const rows = stmt.all(laneId, afterSeq, limit) as any[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /** 校验指定 lane 的哈希链完整性。 */
  verifyLane(laneId: string): { ok: boolean; brokenAtSeq?: number; reason?: string } {
    const events = this.list(laneId, 0, 10000);
    return verifyChain(events);
  }

  private rowToEvent(row: any): LaneEvent {
    return {
      id: row.id,
      laneId: row.lane_id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      actor: JSON.parse(row.actor),
      ts: row.ts,
      payload: JSON.parse(row.payload),
      parentIds: JSON.parse(row.parent_ids),
      artifactIds: JSON.parse(row.artifact_ids),
      prevHash: row.prev_hash,
    };
  }

  close(): void {
    this.db.close();
  }
}
