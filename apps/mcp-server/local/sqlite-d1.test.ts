import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyUpstreamMigrations,
  getLocalEmbeddingState,
  LocalD1Database,
  markLocalEmbeddingIndexed,
  setLocalActiveEmbedding,
} from "./sqlite-d1.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../packages/db/migrations");

test("local embedding state tracks active and indexed fingerprints", () => {
  const dir = mkdtempSync(join(tmpdir(), "engram-local-state-"));
  const db = new LocalD1Database(join(dir, "engram.db"));
  try {
    applyUpstreamMigrations(db.raw, migrationsDir);
    expect(getLocalEmbeddingState(db.raw)).toMatchObject({
      activeFingerprint: null,
      indexedFingerprint: null,
      dimensions: null,
      lastIndexedAt: null,
    });

    setLocalActiveEmbedding(db.raw, "fp-a", 768);
    expect(getLocalEmbeddingState(db.raw)).toMatchObject({
      activeFingerprint: "fp-a",
      indexedFingerprint: null,
      dimensions: 768,
    });
    markLocalEmbeddingIndexed(db.raw, "fp-a", 768);
    const indexed = getLocalEmbeddingState(db.raw);
    expect(indexed).toMatchObject({
      activeFingerprint: "fp-a",
      indexedFingerprint: "fp-a",
      dimensions: 768,
    });
    expect(indexed.lastIndexedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);

    setLocalActiveEmbedding(db.raw, "fp-b", 1024);
    expect(getLocalEmbeddingState(db.raw)).toMatchObject({
      activeFingerprint: "fp-b",
      indexedFingerprint: "fp-a",
      dimensions: 1024,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
