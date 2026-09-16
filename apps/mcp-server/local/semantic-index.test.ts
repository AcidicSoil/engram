import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendMessages, createConversation } from "../src/services/conversation.js";
import type { Env, AuthContext } from "../src/types.js";
import { createLocalVectorize, localContentBucket } from "./local-bindings.js";
import {
  applyUpstreamMigrations,
  getLocalEmbeddingState,
  LocalD1Database,
  seedLocalOwner,
} from "./sqlite-d1.js";
import { LocalSemanticIndexCoordinator } from "./semantic-index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../packages/db/migrations");

function fakeAi(available: boolean) {
  return {
    async run(_model: string, input: { text: string[] }) {
      if (!available) throw new Error("embedding unavailable");
      return { data: input.text.map((text) => [text.length, 1, 0.5]) };
    },
  };
}
function runtime(fingerprint: string) {
  return {
    prepare: vi.fn(async () => {}),
    fingerprint: vi.fn(async () => ({
      id: fingerprint,
      modelUri: "fake:model",
      modelPath: "/cache/model.gguf",
      fileSha256: "a".repeat(64),
      dimensions: 3,
      inputFormatVersion: 1,
    })),
    status: vi.fn(() => ({
      state: "ready" as const,
      model: "fake:model",
      cacheDir: "/cache/engram/models",
      modelPath: "/cache/model.gguf",
      backend: "cpu",
      dimensions: 3,
      fingerprint,
    })),
  };
}

function makeEnv(
  db: LocalD1Database,
  activeFingerprint: () => string,
  available: boolean,
): Env {
  return {
    DB: db as unknown as D1Database,
    CONTENT: localContentBucket as unknown as R2Bucket,
    VECTORIZE: createLocalVectorize(db.raw, {
      fingerprint: activeFingerprint,
    }) as unknown as VectorizeIndex,
    AI: fakeAi(available) as unknown as Ai,
    LOCAL_INLINE_CONTENT: true,
    SELF: {} as Fetcher,
    DRAINER: {} as DurableObjectNamespace,
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_PRICE_ID_PRO: "",
    STRIPE_PRICE_ID_TEAM: "",
    APP_URL: "http://127.0.0.1",
    ADMIN_SECRET: "",
    SUPABASE_JWT_SECRET: "",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
  };
}

const auth: AuthContext = {
  organizationId: "org_local_semantic_test",
  apiKeyId: "local",
  tier: "enterprise",
  scopes: ["read", "write", "search", "delete"],
  seatId: null,
};

test("semantic repair fills missing vectors and replaces incompatible fingerprints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engram-semantic-repair-"));
  const db = new LocalD1Database(join(dir, "engram.db"));
  let activeFingerprint = "fp-a";
  try {
    applyUpstreamMigrations(db.raw, migrationsDir);
    seedLocalOwner(db.raw, auth.organizationId);

    const unavailableEnv = makeEnv(db, () => activeFingerprint, false);
    const conversationId = await createConversation(
      unavailableEnv.DB,
      auth.organizationId,
      "Semantic recovery",
      "local-test",
      ["verification"],
      {},
    );
    await appendMessages(unavailableEnv, auth.organizationId, conversationId, [
      { role: "user", content: "Juniper repair evidence must remain searchable." },
    ]);
    expect(
      (db.raw.prepare("SELECT COUNT(*) AS count FROM local_vectors").get() as { count: number }).count,
    ).toBe(0);

    const readyEnv = makeEnv(db, () => activeFingerprint, true);
    const first = new LocalSemanticIndexCoordinator({
      db: db.raw,
      env: readyEnv,
      auth,
      runtime: runtime("fp-a"),
      repairIntervalMs: 0,
    });
    await first.repairNow();
    expect(getLocalEmbeddingState(db.raw)).toMatchObject({
      activeFingerprint: "fp-a",
      indexedFingerprint: "fp-a",
    });
    expect(first.status()).toMatchObject({ state: "ready", rebuildPending: false });

    activeFingerprint = "fp-b";
    const second = new LocalSemanticIndexCoordinator({
      db: db.raw,
      env: makeEnv(db, () => activeFingerprint, true),
      auth,
      runtime: runtime("fp-b"),
      repairIntervalMs: 0,
    });
    await second.repairNow();
    expect(getLocalEmbeddingState(db.raw)).toMatchObject({
      activeFingerprint: "fp-b",
      indexedFingerprint: "fp-b",
    });
    const rows = db.raw.prepare("SELECT metadata_json FROM local_vectors").all() as Array<{
      metadata_json: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (row) => JSON.parse(row.metadata_json).embedding_fingerprint === "fp-b",
      ),
    ).toBe(true);
    expect(second.status()).toMatchObject({
      state: "ready",
      fingerprint: "fp-b",
      rebuildPending: false,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("semantic preparation can be deferred so MCP discovery runs first", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "engram-semantic-start-"));
  const db = new LocalD1Database(join(dir, "engram.db"));
  try {
    applyUpstreamMigrations(db.raw, migrationsDir);
    seedLocalOwner(db.raw, auth.organizationId);
    const fakeRuntime = runtime("fp-start");
    const coordinator = new LocalSemanticIndexCoordinator({
      db: db.raw,
      env: makeEnv(db, () => "fp-start", true),
      auth,
      runtime: fakeRuntime,
      repairIntervalMs: 0,
    });

    coordinator.start(500);
    expect(fakeRuntime.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(fakeRuntime.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fakeRuntime.prepare).toHaveBeenCalledTimes(1));
    coordinator.stop();
  } finally {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop prevents an in-flight repair from scheduling another run", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "engram-semantic-stop-"));
  const db = new LocalD1Database(join(dir, "engram.db"));
  try {
    applyUpstreamMigrations(db.raw, migrationsDir);
    seedLocalOwner(db.raw, auth.organizationId);
    let releasePrepare!: () => void;
    const delayedRuntime = runtime("fp-stop");
    delayedRuntime.prepare = vi.fn(
      () => new Promise<void>((resolve) => { releasePrepare = resolve; }),
    );
    const coordinator = new LocalSemanticIndexCoordinator({
      db: db.raw,
      env: makeEnv(db, () => "fp-stop", true),
      auth,
      runtime: delayedRuntime,
      repairIntervalMs: 50,
    });

    coordinator.start();
    await vi.waitFor(() => expect(delayedRuntime.prepare).toHaveBeenCalledTimes(1));
    coordinator.stop();
    releasePrepare();
    await coordinator.repairNow();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
