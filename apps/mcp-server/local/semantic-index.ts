import type { DatabaseSync } from "node:sqlite";
import type { AuthContext, Env } from "../src/types.js";
import type {
  EmbeddingFingerprint,
  EmbeddingRuntimeStatus,
  LocalEmbeddingRuntime,
} from "./embedding-runtime.js";
import {
  getLocalEmbeddingState,
  markLocalEmbeddingIndexed,
  setLocalActiveEmbedding,
} from "./sqlite-d1.js";
import { reindexConversation } from "./reindex.js";

const DEFAULT_REPAIR_INTERVAL_MS = 60_000;

type Runtime = Pick<
  LocalEmbeddingRuntime,
  "prepare" | "fingerprint" | "status"
>;

export type LocalSemanticStatus = {
  state: "preparing" | "ready" | "reindexing" | "degraded";
  model: string;
  cachePath: string;
  backend?: string;
  dimensions?: number;
  fingerprint?: string;
  vectorCount: number;
  rebuildPending: boolean;
  error?: string;
};
function vectorFingerprint(metadataJson: string): string | null {
  try {
    const metadata = JSON.parse(metadataJson) as { embedding_fingerprint?: unknown };
    return typeof metadata.embedding_fingerprint === "string"
      ? metadata.embedding_fingerprint
      : null;
  } catch {
    return null;
  }
}

function activeVectorIds(db: DatabaseSync, fingerprint: string): Set<string> {
  const rows = db.prepare("SELECT id, metadata_json FROM local_vectors").all() as Array<{
    id: string;
    metadata_json: string;
  }>;
  return new Set(
    rows
      .filter((row) => vectorFingerprint(row.metadata_json) === fingerprint)
      .map((row) => row.id),
  );
}

function conversationsMissingVectors(
  db: DatabaseSync,
  organizationId: string,
  fingerprint: string,
): string[] {
  const activeIds = activeVectorIds(db, fingerprint);
  const rows = db.prepare(`
    SELECT conversation_id, vectorize_id
    FROM conversation_chunks
    WHERE organization_id = ?
    ORDER BY conversation_id, start_sequence
  `).all(organizationId) as Array<{ conversation_id: string; vectorize_id: string }>;
  return [...new Set(
    rows.filter((row) => !activeIds.has(row.vectorize_id)).map((row) => row.conversation_id),
  )];
}
export class LocalSemanticIndexCoordinator {
  private readonly db: DatabaseSync;
  private readonly env: Env;
  private readonly auth: AuthContext;
  private readonly runtime: Runtime;
  private readonly repairIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private reindexing = false;
  private rebuildPending = true;
  private lastError: string | null = null;

  constructor(options: {
    db: DatabaseSync;
    env: Env;
    auth: AuthContext;
    runtime: Runtime;
    repairIntervalMs?: number;
  }) {
    this.db = options.db;
    this.env = options.env;
    this.auth = options.auth;
    this.runtime = options.runtime;
    this.repairIntervalMs = options.repairIntervalMs ?? DEFAULT_REPAIR_INTERVAL_MS;
  }

  start(initialDelayMs = 0): void {
    this.stopped = false;
    if (initialDelayMs <= 0) {
      void this.repairNow().finally(() => this.scheduleNext());
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.repairNow().finally(() => this.scheduleNext());
    }, initialDelayMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private scheduleNext(): void {
    if (this.stopped || this.repairIntervalMs <= 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.repairNow().finally(() => this.scheduleNext());
    }, this.repairIntervalMs);
    this.timer.unref?.();
  }

  repairNow(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.repairInner()
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.rebuildPending = true;
        process.stderr.write(`[engram-local] semantic repair failed: ${this.lastError}\n`);
      })
      .finally(() => {
        this.reindexing = false;
        this.running = null;
      });
    return this.running;
  }

  private allConversationIds(): string[] {
    return (this.db.prepare(`
      SELECT id FROM conversations
      WHERE organization_id = ?
      ORDER BY created_at, id
    `).all(this.auth.organizationId) as Array<{ id: string }>).map((row) => row.id);
  }

  private conversationsMissingChunks(): string[] {
    return (this.db.prepare(`
      SELECT c.id
      FROM conversations c
      WHERE c.organization_id = ? AND c.message_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM conversation_chunks k
          WHERE k.conversation_id = c.id AND k.organization_id = c.organization_id
        )
      ORDER BY c.created_at, c.id
    `).all(this.auth.organizationId) as Array<{ id: string }>).map((row) => row.id);
  }
  private async repairInner(): Promise<void> {
    await this.runtime.prepare();
    const fingerprint = await this.runtime.fingerprint();
    setLocalActiveEmbedding(this.db, fingerprint.id, fingerprint.dimensions);

    const stored = getLocalEmbeddingState(this.db);
    const fullRebuild = stored.indexedFingerprint !== fingerprint.id;
    if (fullRebuild) {
      this.db.exec("DELETE FROM local_vectors");
    }

    const ids = fullRebuild
      ? this.allConversationIds()
      : [...new Set([
          ...this.conversationsMissingChunks(),
          ...conversationsMissingVectors(
            this.db,
            this.auth.organizationId,
            fingerprint.id,
          ),
        ])];

    this.rebuildPending = ids.length > 0;
    this.reindexing = ids.length > 0;
    for (const id of ids) {
      const result = await reindexConversation(this.env, this.auth, id);
      if (!result.semantic) {
        throw new Error(`semantic indexing unavailable while rebuilding ${id}`);
      }
    }

    markLocalEmbeddingIndexed(this.db, fingerprint.id, fingerprint.dimensions);
    this.rebuildPending = false;
    this.lastError = null;
  }

  status(): LocalSemanticStatus {
    const runtime = this.runtime.status();
    const ready = runtime.state === "ready" ? runtime : null;
    const vectorCount = ready ? activeVectorIds(this.db, ready.fingerprint).size : 0;
    return {
      state: this.reindexing
        ? "reindexing"
        : this.lastError
          ? "degraded"
          : runtime.state,
      model: runtime.model,
      cachePath: runtime.cacheDir,
      ...(ready ? {
        backend: ready.backend,
        dimensions: ready.dimensions,
        fingerprint: ready.fingerprint,
      } : {}),
      vectorCount,
      rebuildPending: this.rebuildPending,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
