import { test, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConversation, appendMessages, getConversation } from "../src/services/conversation.js";
import { searchConversations } from "../src/services/search.js";
import type { Env } from "../src/types.js";
import { applyUpstreamMigrations, LocalD1Database, seedLocalOwner } from "./sqlite-d1.js";
import { createLocalVectorize, localContentBucket } from "./local-bindings.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../packages/db/migrations");

function fakeAi() {
  return {
    async run(_model: string, input: { text: string[] }) {
      return {
        data: input.text.map((text) => {
          const lower = text.toLowerCase();
          return [
            lower.includes("ravenstone") || lower.includes("release") ? 1 : 0,
            lower.includes("rollback") || lower.includes("contingency") ? 1 : 0,
            0.25,
          ];
        }),
      };
    },
  };
}

test("local adapters run upstream conversation and search services", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engram-local-adapter-"));
  const dbPath = join(dir, "engram.db");
  const organizationId = "org_local_test";
  const db = new LocalD1Database(dbPath);
  try {
    applyUpstreamMigrations(db.raw, migrationsDir);
    seedLocalOwner(db.raw, organizationId);
    const env = {
      DB: db as unknown as D1Database,
      CONTENT: localContentBucket as unknown as R2Bucket,
      VECTORIZE: createLocalVectorize(db.raw) as unknown as VectorizeIndex,
      AI: fakeAi() as unknown as Ai,
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
    } satisfies Env;

    const conversationId = await createConversation(
      env.DB,
      organizationId,
      "Ravenstone release",
      "local-test",
      ["verification"],
      {},
    );
    const messages = await appendMessages(env, organizationId, conversationId, [
      { role: "user", content: "Ravenstone needs a verified rollback plan before release." },
      { role: "assistant", content: "The release contingency is recorded." },
    ]);
    expect(messages.length).toBe(2);

    const stored = await getConversation(env, organizationId, conversationId, 1, 0);
    expect(stored?.messages[0].content).toBe("Ravenstone needs a verified rollback plan before release.");
    expect(stored?.messages[0].sequence).toBe(1);

    const keyword = await searchConversations(env, organizationId, "Ravenstone", 5);
    expect(keyword[0]?.conversation_id).toBe(conversationId);

    const semantic = await searchConversations(env, organizationId, "release contingency", 5);
    expect(semantic[0]?.conversation_id).toBe(conversationId);

    const migrations = db.raw.prepare("SELECT COUNT(*) AS count FROM _local_migrations").get() as { count: number };
    const expectedMigrations = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).length;
    expect(migrations.count).toBe(expectedMigrations);
    const vectors = db.raw.prepare("SELECT COUNT(*) AS count FROM local_vectors").get() as { count: number };
    expect(vectors.count).toBeGreaterThan(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embedding failure does not block chunk persistence or FTS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engram-local-fts-fallback-"));
  const db = new LocalD1Database(join(dir, "engram.db"));
  const organizationId = "org_local_fts_test";
  try {
    applyUpstreamMigrations(db.raw, migrationsDir);
    seedLocalOwner(db.raw, organizationId);
    const unavailableAi = {
      async run() {
        throw new Error("embedding runtime unavailable");
      },
    };
    const env = {
      DB: db as unknown as D1Database,
      CONTENT: localContentBucket as unknown as R2Bucket,
      VECTORIZE: createLocalVectorize(db.raw) as unknown as VectorizeIndex,
      AI: unavailableAi as unknown as Ai,
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
    } satisfies Env;
    const conversationId = await createConversation(
      env.DB,
      organizationId,
      "FTS fallback",
      "local-test",
      ["verification"],
      {},
    );
    const messages = await appendMessages(env, organizationId, conversationId, [
      { role: "user", content: "Copperfin protocol survives semantic indexing outages." },
    ]);
    expect(messages).toHaveLength(1);

    const chunkCount = db.raw
      .prepare("SELECT COUNT(*) AS count FROM conversation_chunks WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    expect(chunkCount.count).toBeGreaterThan(0);

    const results = await searchConversations(env, organizationId, "Copperfin", 5);
    expect(results[0]?.conversation_id).toBe(conversationId);
    const vectorCount = db.raw.prepare("SELECT COUNT(*) AS count FROM local_vectors").get() as {
      count: number;
    };
    expect(vectorCount.count).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
