#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMcpServer } from "../src/mcp/server.js";
import type { AuthContext, Env } from "../src/types.js";
import { applyUpstreamMigrations, LocalD1Database, seedLocalOwner } from "./sqlite-d1.js";
import { createLocalAi, createLocalVectorize, localContentBucket } from "./local-bindings.js";
import { LocalEmbeddingRuntime } from "./embedding-runtime.js";
import { LocalSemanticIndexCoordinator } from "./semantic-index.js";
import { reindexConversation } from "./reindex.js";
import { registerAbptTools } from "./abpt-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const migrationsDir = join(repoRoot, "packages", "db", "migrations");
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const dbPath = process.env.ENGRAM_LOCAL_DB ?? join(dataHome, "engram", "local.db");
const organizationId = "org_local";
const abptApiUrl = process.env.ABPT_API_URL ?? "http://127.0.0.1:4318";

const localDb = new LocalD1Database(dbPath);
applyUpstreamMigrations(localDb.raw, migrationsDir);
seedLocalOwner(localDb.raw, organizationId);
const embeddingRuntime = new LocalEmbeddingRuntime();

function activeEmbeddingFingerprint(): string | null {
  const status = embeddingRuntime.status();
  return status.state === "ready" ? status.fingerprint : null;
}

const env = {
  DB: localDb as unknown as D1Database,
  CONTENT: localContentBucket as unknown as R2Bucket,
  VECTORIZE: createLocalVectorize(localDb.raw, {
    fingerprint: activeEmbeddingFingerprint,
  }) as unknown as VectorizeIndex,
  AI: createLocalAi(embeddingRuntime) as unknown as Ai,
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

const auth: AuthContext = {
  organizationId,
  apiKeyId: "local",
  tier: "enterprise",
  scopes: ["read", "write", "search", "delete"],
  seatId: null,
};

const semanticIndex = new LocalSemanticIndexCoordinator({
  db: localDb.raw,
  env,
  auth,
  runtime: embeddingRuntime,
});

const server = createMcpServer(env, auth, {
  mode: "local",
  localStatus: () => semanticIndex.status(),
});
registerAbptTools(server, { baseUrl: abptApiUrl });
server.registerTool(
  "reindex",
  {
    description: "Rebuild derived keyword and semantic search data from canonical local conversation messages. Omit conversation_id to rebuild every local conversation.",
    inputSchema: { conversation_id: z.string().optional() },
    annotations: {
      title: "Reindex local memory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ conversation_id }) => {
    const ids = conversation_id
      ? [conversation_id]
      : (localDb.raw.prepare("SELECT id FROM conversations WHERE organization_id = ? ORDER BY created_at").all(organizationId) as Array<{ id: string }>).map((row) => row.id);
    const results = [];
    for (const id of ids) results.push(await reindexConversation(env, auth, id));
    const payload = { conversations_reindexed: results.length, results };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
);
await server.connect(new StdioServerTransport());
semanticIndex.start(1000);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  semanticIndex.stop();
  try {
    await embeddingRuntime.dispose();
  } finally {
    localDb.close();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
