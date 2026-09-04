import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    assert.equal(messages.length, 2);

    const stored = await getConversation(env, organizationId, conversationId, 1, 0);
    assert.equal(stored?.messages[0].content, "Ravenstone needs a verified rollback plan before release.");
    assert.equal(stored?.messages[0].sequence, 1);

    const keyword = await searchConversations(env, organizationId, "Ravenstone", 5);
    assert.equal(keyword[0]?.conversation_id, conversationId);

    const semantic = await searchConversations(env, organizationId, "release contingency", 5);
    assert.equal(semantic[0]?.conversation_id, conversationId);

    const migrations = db.raw.prepare("SELECT COUNT(*) AS count FROM _local_migrations").get() as { count: number };
    assert.equal(migrations.count, 36);
    const vectors = db.raw.prepare("SELECT COUNT(*) AS count FROM local_vectors").get() as { count: number };
    assert.ok(vectors.count > 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
