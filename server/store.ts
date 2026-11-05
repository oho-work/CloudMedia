import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { State } from '../shared/types.js';
import { initialState, settingsDefaults, sourceDefaults } from './defaults.js';
import { PostgresPosterStorage, posterTableSql, type PosterStorage } from './poster-storage.js';
import { MemoryPosterStorage } from './memory-poster-storage.js';

type Table = 'sources' | 'movies' | 'resources' | 'runs';
const tables: Table[] = ['sources', 'movies', 'resources', 'runs'];
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}
export class Store {
  state: State = initialState();
  readonly mode: 'postgres' | 'file';
  private pool?: pg.Pool;
  private posters?: PosterStorage;
  private schema: string;
  private file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private persisted = new Map<string, string>();
  private lockClient?: pg.PoolClient;
  private failure?: Error;
  onFatal?: () => void;
  get healthy() { return !this.failure; }
  get posterStorage(): PosterStorage | undefined { return this.posters; }
  constructor() {
    this.mode = process.env.DATABASE_URL ? 'postgres' : 'file';
    if (this.mode === 'file') this.posters = new MemoryPosterStorage();
    this.schema = process.env.PGSCHEMA || 'cloudmedia';
    if (!/^[a-z_][a-z0-9_]*$/.test(this.schema)) throw new Error('PGSCHEMA 格式无效');
    this.file = path.resolve(process.env.DATA_FILE || './data/cloudmedia.json');
  }
  async init() {
    if (this.mode === 'postgres') {
      this.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 8000 });
      this.posters = new PostgresPosterStorage(this.pool, this.schema);
      this.pool.on('error', () => console.error('PostgreSQL 后台连接中断，请检查数据库服务'));
      this.lockClient = await this.pool.connect();
      this.lockClient.on('error', () => {
        this.failure = new Error('PostgreSQL 会话中断，服务需要重新启动以确保目录一致性');
        console.error(this.failure.message);
        this.lockClient?.release(true); this.lockClient = undefined;
        this.onFatal?.();
      });
      const lock = await this.lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`cloudmedia:${this.schema}`]);
      if (!lock.rows[0].locked) { this.lockClient.release(); this.lockClient = undefined; throw new Error('该 schema 已有 CloudMedia 实例运行，请停止旧实例或使用独立 PGSCHEMA'); }
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
        await client.query(posterTableSql(this.schema));
        await client.query(`CREATE TABLE IF NOT EXISTS "${this.schema}".settings (id text PRIMARY KEY, data jsonb NOT NULL)`);
        for (const table of tables) {
          await client.query(`CREATE TABLE IF NOT EXISTS "${this.schema}".${table} (id text PRIMARY KEY, data jsonb NOT NULL)`);
        }
        await client.query(`CREATE INDEX IF NOT EXISTS resources_movie_id ON "${this.schema}".resources ((data->>'movieId'))`);
        await client.query(`CREATE INDEX IF NOT EXISTS movies_updated_at ON "${this.schema}".movies ((data->>'updatedAt'))`);
        await client.query(`CREATE INDEX IF NOT EXISTS movies_title ON "${this.schema}".movies ((data->>'title'))`);
        const settings = await client.query(`SELECT data FROM "${this.schema}".settings WHERE id='global'`);
        if (settings.rows.length) {
          this.state.settings = settingsDefaults(settings.rows[0].data);
          for (const table of tables) {
            const rows = await client.query(`SELECT data FROM "${this.schema}".${table}`);
            // Compare saves to the stored rows before startup defaults or run recovery change them.
            for (const row of rows.rows) this.persisted.set(`${table}:${row.data.id}`, canonicalJson(row.data));
            (this.state[table] as unknown[]) = rows.rows.map(row => row.data);
          }
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } else {
      try { const data = JSON.parse(await readFile(this.file, 'utf8')); this.state = { ...this.state, ...data, settings: settingsDefaults(data.settings) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.state.sources = this.state.sources.map(source => sourceDefaults(source));
    for (const run of this.state.runs) if (run.status === 'running' || run.status === 'queued') {
      run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); run.message = '服务重启，任务已中断，可重新采集';
      if (run.progress) {
        run.progress.activeMovies = 0; run.progress.activeMovieTitles = [];
        if (run.progress.activeMovieProgress !== undefined) run.progress.activeMovieProgress = [];
        run.progress.probes.active = 0; run.progress.probes.queued = 0;
      }
    }
    await this.save();
  }
  save(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    // Snapshot immediately; saves are serialized so disk state always follows mutation order.
    const snapshot = JSON.stringify(this.state);
    const task = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (!this.pool) {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, snapshot, 'utf8');
        // Windows readers or antivirus can briefly hold the destination open.
        // Keep the complete temporary snapshot and retry replacement in place.
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, this.file); break; }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt >= 5) throw error;
            await delay(10 * 2 ** attempt);
          }
        }
        return;
      }
      const state: State = JSON.parse(snapshot);
      const client = await this.pool.connect();
      const next = new Map<string, string>();
      try {
        await client.query('BEGIN');
        // The instance-level advisory lock prevents concurrent writers for this schema.
        for (const table of tables) {
          const values = state[table];
          for (const value of values) {
            const json = canonicalJson(value); const key = `${table}:${value.id}`; next.set(key, json);
            if (this.persisted.get(key) === json) continue;
            await client.query(`INSERT INTO "${this.schema}".${table} (id,data) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, [value.id, json]);
          }
          const removed = [...this.persisted.keys()].filter(key => key.startsWith(`${table}:`) && !next.has(key)).map(key => key.slice(table.length + 1));
          if (removed.length) await client.query(`DELETE FROM "${this.schema}".${table} WHERE id=ANY($1::text[])`, [removed]);
        }
        await client.query(`INSERT INTO "${this.schema}".settings (id,data) VALUES ('global',$1::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, [JSON.stringify(state.settings)]);
        await client.query('COMMIT'); this.persisted = next;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async close() {
    await this.tail;
    if (this.lockClient) { await this.lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [`cloudmedia:${this.schema}`]); this.lockClient.release(); this.lockClient = undefined; }
    await this.pool?.end();
    this.posters = undefined;
  }
}
