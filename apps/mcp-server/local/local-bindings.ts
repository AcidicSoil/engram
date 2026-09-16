import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingPurpose, EmbeddingRuntimeStatus, LocalEmbeddingRuntime } from "./embedding-runtime.js";

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : -1;
}

type LocalEmbeddingAdapterRuntime = Pick<LocalEmbeddingRuntime, "embed" | "status">;

export function createLocalAi(runtime: LocalEmbeddingAdapterRuntime) {
  return {
    async embed(texts: string[], purpose: EmbeddingPurpose) {
      const status: EmbeddingRuntimeStatus = runtime.status();
      if (status.state !== "ready") {
        throw new Error(`local semantic runtime is ${status.state}`);
      }
      return runtime.embed(texts, purpose);
    },
  };
}

export function createLocalVectorize(
  db: DatabaseSync,
  runtimeOptions: { fingerprint?: () => string | null } = {},
) {
  return {
    async upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) {
      const stmt = db.prepare(`
        INSERT INTO local_vectors(id, values_json, metadata_json, updated_at)
        VALUES(?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          values_json=excluded.values_json,
          metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        const fingerprint = runtimeOptions.fingerprint?.();
        if (runtimeOptions.fingerprint && !fingerprint) {
          throw new Error("active embedding fingerprint is unavailable");
        }
        for (const vector of vectors) {
          const metadata = {
            ...(vector.metadata ?? {}),
            ...(fingerprint ? { embedding_fingerprint: fingerprint } : {}),
          };
          stmt.run(vector.id, JSON.stringify(vector.values), JSON.stringify(metadata));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { count: vectors.length };
    },

    async insert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) {
      return this.upsert(vectors);
    },

    async query(values: number[], queryOptions: { topK?: number; filter?: Record<string, unknown> } = {}) {
      const rows = db.prepare("SELECT id, values_json, metadata_json FROM local_vectors").all() as Array<{
        id: string;
        values_json: string;
        metadata_json: string;
      }>;
      const activeFingerprint = runtimeOptions.fingerprint?.();
      if (runtimeOptions.fingerprint && !activeFingerprint) return { matches: [] };
      const filter = {
        ...(queryOptions.filter ?? {}),
        ...(activeFingerprint ? { embedding_fingerprint: activeFingerprint } : {}),
      };
      const matches = rows.flatMap((row) => {
        const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        for (const [key, expected] of Object.entries(filter)) {
          if (metadata[key] !== expected) return [];
        }
        const vector = JSON.parse(row.values_json) as number[];
        return [{ id: row.id, score: cosine(values, vector), metadata }];
      })
        .sort((a, b) => b.score - a.score)
        .slice(0, queryOptions.topK ?? 5);
      return { matches };
    },

    async deleteByIds(ids: string[]) {
      if (ids.length === 0) return { count: 0 };
      const stmt = db.prepare("DELETE FROM local_vectors WHERE id = ?");
      let count = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids) count += Number(stmt.run(id).changes ?? 0);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { count };
    },

    async getByIds(ids: string[]) {
      const stmt = db.prepare("SELECT id, values_json, metadata_json FROM local_vectors WHERE id = ?");
      return ids.flatMap((id) => {
        const row = stmt.get(id) as { id: string; values_json: string; metadata_json: string } | undefined;
        return row ? [{ id: row.id, values: JSON.parse(row.values_json), metadata: JSON.parse(row.metadata_json) }] : [];
      });
    },

    async describe() {
      const row = db.prepare("SELECT COUNT(*) AS count FROM local_vectors").get() as { count: number };
      return { vectorsCount: row.count };
    },
  };
}

export const localContentBucket = {
  async put() { throw new Error("R2 is disabled in local inline-content mode"); },
  async get() { return null; },
  async delete() {},
  async head() { return null; },
  async list() { return { objects: [] }; },
};
