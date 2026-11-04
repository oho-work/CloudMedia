import { createHash } from 'node:crypto';

export interface PosterBinary {
  path: string; sha256: string; mime: string; data: Buffer; downloadedAt: string;
}
export interface PosterStorage {
  get(path: string): Promise<PosterBinary | null>;
  put(value: PosterBinary): Promise<void>;
}
interface PosterDatabase {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

const maxBytes = 4 * 1024 * 1024;
const posterPattern = /^\/media\/posters\/[a-f0-9]{64}\.(jpg|png|webp|avif|gif)$/;
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
};
function qualifiedTable(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('海报存储 schema 格式无效');
  return `"${schema}".poster_files`;
}
function validate(value: PosterBinary): void {
  const match = posterPattern.exec(value.path);
  if (!match || match[0] !== value.path || extensions[value.mime] !== match[1]) throw new Error('海报路径或图片类型无效');
  if (!Buffer.isBuffer(value.data) || value.data.length <= 0 || value.data.length > maxBytes) throw new Error('海报内容为空或超过 4 MiB');
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || createHash('sha256').update(value.data).digest('hex') !== value.sha256) throw new Error('海报内容摘要不匹配');
  if (!Number.isFinite(new Date(value.downloadedAt).getTime())) throw new Error('海报下载时间无效');
}

/** Kept separate from catalog JSON so image buffers never enter the in-memory catalog. */
export function posterTableSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schema)} (
    path text PRIMARY KEY CHECK (path ~ '^/media/posters/[a-f0-9]{64}[.](jpg|png|webp|avif|gif)$'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')),
    bytes bytea NOT NULL CHECK (octet_length(bytes) > 0 AND octet_length(bytes) <= 4194304),
    downloaded_at timestamptz NOT NULL
  )`;
}

/** All errors propagate: PostgreSQL deployments never fall back to writing image files. */
export class PostgresPosterStorage implements PosterStorage {
  private table: string;
  constructor(private database: PosterDatabase, schema: string) { this.table = qualifiedTable(schema); }

  async get(path: string): Promise<PosterBinary | null> {
    if (posterPattern.exec(path)?.[0] !== path) return null;
    const result = await this.database.query(`SELECT path, sha256, mime, bytes, downloaded_at FROM ${this.table} WHERE path=$1`, [path]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    if (row.path !== path) throw new Error('数据库海报路径不匹配');
    if (!Buffer.isBuffer(row.bytes)) throw new Error('数据库海报内容无效');
    const downloadedAt = row.downloaded_at instanceof Date ? row.downloaded_at.toISOString() : String(row.downloaded_at);
    const poster: PosterBinary = { path: row.path, sha256: row.sha256, mime: row.mime, data: Buffer.from(row.bytes), downloadedAt };
    validate(poster);
    return poster;
  }

  async put(value: PosterBinary): Promise<void> {
    validate(value);
    // Copy the caller's bytes before awaiting database I/O.
    const data = Buffer.from(value.data);
    const result = await this.database.query(`INSERT INTO ${this.table} (path,sha256,mime,bytes,downloaded_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(path) DO NOTHING RETURNING path`,
    [value.path, value.sha256, value.mime, data, value.downloadedAt]);
    if (result.rows.length) return;
    const existing = await this.get(value.path);
    if (!existing || existing.sha256 !== value.sha256 || existing.mime !== value.mime || !existing.data.equals(data)) {
      throw new Error('海报路径已有不同内容，拒绝覆盖不可变海报');
    }
  }
}
