import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { generateId } from "@getengram/shared";
import { z } from "zod";
import { applyUpstreamMigrations, LocalD1Database, seedLocalOwner } from "./sqlite-d1.js";

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  sequence: z.number().int(),
  created_at: z.string().min(1),
  tool_name: z.string().min(1).optional(),
}).strict();

const conversationSchema = z.object({
  id: z.string().startsWith("conv_"),
  title: z.string().nullable(),
  agent_id: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.unknown()),
  message_count: z.number().int().nonnegative(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  messages: z.array(messageSchema),
}).strict().superRefine((conversation, ctx) => {
  if (conversation.message_count !== conversation.messages.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message_count"],
      message: `message_count=${conversation.message_count} does not match messages.length=${conversation.messages.length}`,
    });
  }
  const sequences = new Set<number>();
  for (const [index, message] of conversation.messages.entries()) {
    if (sequences.has(message.sequence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages", index, "sequence"],
        message: `duplicate sequence ${message.sequence}`,
      });
    }
    sequences.add(message.sequence);
  }
});

const exportSchema = z.object({
  export_version: z.literal("1.0"),
  exported_at: z.string().min(1),
  organization: z.object({
    id: z.string().min(1),
    name: z.string().nullable(),
    email: z.string().nullable(),
    tier: z.string().min(1),
    created_at: z.string().min(1),
  }).strict(),
  conversations: z.array(conversationSchema),
}).strict();

export type EngramExport = z.infer<typeof exportSchema>;
type ExportConversation = EngramExport["conversations"][number];

type ExistingConversation = {
  id: string;
  title: string | null;
  agent_id: string | null;
  tags: string;
  metadata: string;
  message_count: number;
  created_at: string;
  updated_at: string;
};

type ExistingMessage = {
  role: string;
  content: string;
  sequence: number;
  created_at: string;
  tool_name: string | null;
};

const existingConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agent_id: z.string().nullable(),
  tags: z.string(),
  metadata: z.string(),
  message_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
const existingMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  sequence: z.number(),
  created_at: z.string(),
  tool_name: z.string().nullable(),
});

export function parseEngramExport(raw: string): EngramExport {
  return exportSchema.parse(JSON.parse(raw) as unknown);
}

function parseStoredJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function existingConversation(db: DatabaseSync, id: string): ExistingConversation | null {
  const row = db.prepare(`
    SELECT id, title, agent_id, tags, metadata, message_count, created_at, updated_at
    FROM conversations WHERE id = ?
  `).get(id);
  return row ? existingConversationSchema.parse(row) : null;
}

function existingMessages(db: DatabaseSync, conversationId: string): ExistingMessage[] {
  return db.prepare(`
    SELECT role, content, sequence, created_at, tool_name
    FROM messages WHERE conversation_id = ?
    ORDER BY sequence ASC, created_at ASC, id ASC
  `).all(conversationId).map((row) => existingMessageSchema.parse(row));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function conversationMatches(db: DatabaseSync, exported: ExportConversation): boolean {
  const current = existingConversation(db, exported.id);
  if (!current) return false;
  if (
    current.title !== exported.title ||
    current.agent_id !== exported.agent_id ||
    current.message_count !== exported.message_count ||
    current.created_at !== exported.created_at ||
    current.updated_at !== exported.updated_at ||
    !sameJson(parseStoredJson(current.tags), exported.tags) ||
    !sameJson(parseStoredJson(current.metadata), exported.metadata)
  ) return false;

  const messages = existingMessages(db, exported.id);
  if (messages.length !== exported.messages.length) return false;
  return messages.every((message, index) => {
    const source = exported.messages[index];
    return source !== undefined &&
      message.role === source.role &&
      message.content === source.content &&
      message.sequence === source.sequence &&
      message.created_at === source.created_at &&
      message.tool_name === (source.tool_name ?? null);
  });
}

export type RestorePlan = {
  insert: ExportConversation[];
  skipped: string[];
};

export function planEngramExportRestore(db: DatabaseSync, data: EngramExport): RestorePlan {
  const insert: ExportConversation[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  for (const conversation of data.conversations) {
    const current = existingConversation(db, conversation.id);
    if (!current) {
      insert.push(conversation);
      continue;
    }
    if (conversationMatches(db, conversation)) skipped.push(conversation.id);
    else conflicts.push(conversation.id);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite ${conflicts.length} existing conversation(s) with conflicting data: ${conflicts.join(", ")}`,
    );
  }
  return { insert, skipped };
}

function restoreConversation(
  db: DatabaseSync,
  organizationId: string,
  sourceOrganizationId: string,
  conversation: ExportConversation,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO conversations (
        id, organization_id, title, agent_id, tags, metadata, message_count,
        created_at, updated_at, import_fingerprint, seat_id, visibility
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'shared')
    `).run(
      conversation.id,
      organizationId,
      conversation.title,
      conversation.agent_id,
      JSON.stringify(conversation.tags),
      JSON.stringify(conversation.metadata),
      conversation.messages.length,
      conversation.created_at,
      conversation.updated_at,
      `engram-export:${sourceOrganizationId}:${conversation.id}`,
    );

    const tagStatement = db.prepare(`
      INSERT OR IGNORE INTO conversation_tags (conversation_id, organization_id, tag)
      VALUES (?, ?, ?)
    `);
    for (const tag of conversation.tags) {
      if (tag) tagStatement.run(conversation.id, organizationId, tag);
    }

    const messageStatement = db.prepare(`
      INSERT INTO messages (
        id, conversation_id, organization_id, role, content, content_encoding,
        tool_call_id, tool_name, sequence, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, '{}', ?)
    `);
    for (const message of conversation.messages) {
      messageStatement.run(
        generateId("msg"),
        conversation.id,
        organizationId,
        message.role,
        message.content,
        message.tool_name ?? null,
        message.sequence,
        message.created_at,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reconcileLocalCounters(db: DatabaseSync, organizationId: string): void {
  db.prepare(`
    UPDATE organizations SET
      messages_stored_total = (SELECT COUNT(*) FROM messages WHERE organization_id = ?),
      conversation_count = (SELECT COUNT(*) FROM conversations WHERE organization_id = ?)
    WHERE id = ?
  `).run(organizationId, organizationId, organizationId);
}

export type RestoreResult = {
  conversationsImported: number;
  conversationsSkipped: number;
  messagesImported: number;
};

export function restoreEngramExport(
  db: DatabaseSync,
  data: EngramExport,
  organizationId = "org_local",
): RestoreResult {
  const plan = planEngramExportRestore(db, data);
  for (const conversation of plan.insert) {
    restoreConversation(db, organizationId, data.organization.id, conversation);
  }
  reconcileLocalCounters(db, organizationId);
  return {
    conversationsImported: plan.insert.length,
    conversationsSkipped: plan.skipped.length,
    messagesImported: plan.insert.reduce((total, conversation) => total + conversation.messages.length, 0),
  };
}

export function importPathFromArgs(args: string[]): string | null {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  return normalized[0] ?? null;
}

async function main(): Promise<void> {
  const inputPath = importPathFromArgs(process.argv.slice(2));
  if (!inputPath) {
    throw new Error("Usage: pnpm --filter @getengram/mcp-server run import:local-export -- /path/to/engram-export.json");
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  const migrationsDir = join(repoRoot, "packages", "db", "migrations");
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const dbPath = process.env.ENGRAM_LOCAL_DB ?? join(dataHome, "engram", "local.db");
  const data = parseEngramExport(readFileSync(inputPath, "utf8"));
  const localDb = new LocalD1Database(dbPath);
  try {
    applyUpstreamMigrations(localDb.raw, migrationsDir);
    seedLocalOwner(localDb.raw);
    const result = restoreEngramExport(localDb.raw, data);
    process.stdout.write(`${JSON.stringify({ dbPath, inputPath, ...result })}\n`);
  } finally {
    localDb.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
