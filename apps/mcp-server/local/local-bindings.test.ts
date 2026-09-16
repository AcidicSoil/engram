import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1Database } from "./sqlite-d1.js";
import { createLocalAi, createLocalVectorize } from "./local-bindings.js";

test("local vector search only uses the active embedding fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engram-local-vectors-"));
  const db = new LocalD1Database(join(dir, "engram.db"));
  db.raw.exec(`
    CREATE TABLE local_vectors (
      id TEXT PRIMARY KEY,
      values_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  let fingerprint = "fp-a";
  try {
    const vectorize = createLocalVectorize(db.raw, {
      fingerprint: () => fingerprint,
    });
    await vectorize.upsert([
      {
        id: "chunk-a",
        values: [1, 0],
        metadata: { organization_id: "org_local", conversation_id: "conv-a" },
      },
    ]);

    fingerprint = "fp-b";
    const stale = await vectorize.query([1, 0], {
      topK: 5,
      filter: { organization_id: "org_local" },
    });
    expect(stale.matches).toEqual([]);
    await vectorize.upsert([
      {
        id: "chunk-b",
        values: [1, 0],
        metadata: { organization_id: "org_local", conversation_id: "conv-b" },
      },
    ]);
    const current = await vectorize.query([1, 0], {
      topK: 5,
      filter: { organization_id: "org_local" },
    });
    expect(current.matches.map((match) => match.id)).toEqual(["chunk-b"]);

    const row = db.raw
      .prepare("SELECT metadata_json FROM local_vectors WHERE id = ?")
      .get("chunk-b") as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      embedding_fingerprint: "fp-b",
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local AI fails fast while the model is preparing", async () => {
  const embed = vi.fn(async () => [[1, 2, 3]]);
  const ai = createLocalAi({
    status: () => ({
      state: "preparing" as const,
      model: "fake:model",
      cacheDir: "/cache",
    }),
    embed,
  } as never);

  await expect(ai.embed(["query"], "query")).rejects.toThrow(/preparing/);
  expect(embed).not.toHaveBeenCalled();
});
