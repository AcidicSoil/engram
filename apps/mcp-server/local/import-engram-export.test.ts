import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  importPathFromArgs,
  parseEngramExport,
  restoreEngramExport,
} from "./import-engram-export.js";
import { applyUpstreamMigrations, LocalD1Database, seedLocalOwner } from "./sqlite-d1.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../packages/db/migrations");

function sampleExport() {
  return {
    export_version: "1.0",
    exported_at: "2026-09-16T20:21:22.294Z",
    organization: {
      id: "org_source",
      name: "Source Org",
      email: "source@example.com",
      tier: "free",
      created_at: "2026-08-18 08:09:45",
    },
    conversations: [{
      id: "conv_restore_test",
      title: "Imported memory",
      agent_id: "chatgpt",
      tags: ["memory", "restore"],
      metadata: { purpose: "restore proof" },
      message_count: 2,
      created_at: "2026-08-21 11:30:30",
      updated_at: "2026-08-21 11:30:38",
      messages: [
        {
          role: "system",
          content: "System memory",
          sequence: 0,
          created_at: "2026-08-21 11:30:30",
        },
        {
          role: "user",
          content: "Remember this",
          sequence: 1,
          created_at: "2026-08-21 11:30:38",
        },
      ],
    }],
  };
}

describe("local Engram export restore", () => {
  test("accepts pnpm's argument separator", () => {
    expect(importPathFromArgs(["--", "/tmp/export.json"])).toBe("/tmp/export.json");
    expect(importPathFromArgs(["/tmp/export.json"])).toBe("/tmp/export.json");
    expect(importPathFromArgs([])).toBeNull();
  });

  test("preserves exported conversation data and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-export-restore-"));
    const db = new LocalD1Database(join(dir, "local.db"));
    try {
      applyUpstreamMigrations(db.raw, migrationsDir);
      seedLocalOwner(db.raw);
      const data = parseEngramExport(JSON.stringify(sampleExport()));

      expect(restoreEngramExport(db.raw, data)).toEqual({
        conversationsImported: 1,
        conversationsSkipped: 0,
        messagesImported: 2,
      });

      const conversation = db.raw.prepare(`
        SELECT id, title, agent_id, tags, metadata, message_count,
               created_at, updated_at, import_fingerprint
        FROM conversations WHERE id = 'conv_restore_test'
      `).get();
      expect(conversation).toMatchObject({
        id: "conv_restore_test",
        title: "Imported memory",
        agent_id: "chatgpt",
        tags: JSON.stringify(["memory", "restore"]),
        metadata: JSON.stringify({ purpose: "restore proof" }),
        message_count: 2,
        created_at: "2026-08-21 11:30:30",
        updated_at: "2026-08-21 11:30:38",
        import_fingerprint: "engram-export:org_source:conv_restore_test",
      });

      const messages = db.raw.prepare(`
        SELECT role, content, sequence, created_at FROM messages
        WHERE conversation_id = 'conv_restore_test' ORDER BY sequence
      `).all();
      expect(messages).toEqual([
        { role: "system", content: "System memory", sequence: 0, created_at: "2026-08-21 11:30:30" },
        { role: "user", content: "Remember this", sequence: 1, created_at: "2026-08-21 11:30:38" },
      ]);

      expect(db.raw.prepare(`
        SELECT messages_stored_total, conversation_count FROM organizations WHERE id = 'org_local'
      `).get()).toMatchObject({ messages_stored_total: 2, conversation_count: 1 });

      expect(restoreEngramExport(db.raw, data)).toEqual({
        conversationsImported: 0,
        conversationsSkipped: 1,
        messagesImported: 0,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM messages").get()).toMatchObject({ count: 2 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses conflicting existing conversation ids before overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-export-conflict-"));
    const db = new LocalD1Database(join(dir, "local.db"));
    try {
      applyUpstreamMigrations(db.raw, migrationsDir);
      seedLocalOwner(db.raw);
      const first = parseEngramExport(JSON.stringify(sampleExport()));
      restoreEngramExport(db.raw, first);
      const changed = sampleExport();
      changed.conversations[0]!.title = "Conflicting title";
      const conflict = parseEngramExport(JSON.stringify(changed));

      expect(() => restoreEngramExport(db.raw, conflict)).toThrow(/Refusing to overwrite/);
      expect(db.raw.prepare(`
        SELECT title FROM conversations WHERE id = 'conv_restore_test'
      `).get()).toMatchObject({ title: "Imported memory" });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects internally inconsistent exports at the JSON boundary", () => {
    const bad = sampleExport();
    bad.conversations[0]!.message_count = 99;
    expect(() => parseEngramExport(JSON.stringify(bad))).toThrow(/message_count=99/);
  });
});
