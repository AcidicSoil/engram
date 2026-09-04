import { DatabaseSync, type StatementSync } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface RunMeta {
  changes?: number;
  last_row_id?: number;
}

class LocalD1Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new LocalD1Statement(this.db, this.sql, values);
  }

  private statement(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async run() {
    const result = this.statement().run(...this.bindings);
    const meta: RunMeta = { changes: Number(result.changes ?? 0) };
    if (result.lastInsertRowid != null) meta.last_row_id = Number(result.lastInsertRowid);
    return { success: true, results: [], meta };
  }

  async first<T = Record<string, unknown>>() {
    const row = this.statement().get(...this.bindings);
    return (row ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>() {
    const rows = this.statement().all(...this.bindings) as T[];
    return { success: true, results: rows, meta: {} };
  }
}

export class LocalD1Database {
  readonly raw: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    try { chmodSync(dbPath, 0o600); } catch {}
  }

  prepare(sql: string) {
    return new LocalD1Statement(this.raw, sql);
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }

  async batch(statements: LocalD1Statement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

export function applyUpstreamMigrations(db: DatabaseSync, migrationsDir: string) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _local_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT name FROM _local_migrations").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    if (file === "0003_team_tier.sql" && !hasColumn(db, "organizations", "email")) {
      db.exec("ALTER TABLE organizations ADD COLUMN email TEXT");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      db.prepare("INSERT INTO _local_migrations(name) VALUES(?)").run(file);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`local migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS local_vectors (
      id TEXT PRIMARY KEY,
      values_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function seedLocalOwner(db: DatabaseSync, organizationId = "org_local") {
  db.prepare(`
    INSERT OR IGNORE INTO organizations(id, name, email, tier)
    VALUES(?, 'Local Engram', 'local@localhost', 'enterprise')
  `).run(organizationId);
  db.prepare("UPDATE organizations SET tier='enterprise' WHERE id=?").run(organizationId);
}
