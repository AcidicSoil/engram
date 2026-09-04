import {
  getConversationById,
  getMessageById,
  getMessagesByMemorySourceConversation,
} from "@getengram/db";
import { loadContent } from "./content-store.js";
import { canAccessConversation } from "./spaces.js";
import type { Env, AuthContext } from "../types.js";

export interface MemoryProvenanceSource {
  type: string;
  conversation_id: string;
  message_ids?: string[];
  start_sequence?: number;
  end_sequence?: number;
  uri?: string;
}

export interface MemoryProvenanceReason {
  type: string;
  text: string;
}

export interface MemoryProvenance {
  source: MemoryProvenanceSource;
  reason: MemoryProvenanceReason;
  actor?: string;
  created_at?: string;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  content_encoding: string | null;
  sequence: number;
  metadata: string | Record<string, unknown>;
  created_at: string;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

export function readMemoryProvenance(
  metadata: unknown,
  fallbackCreatedAt?: string,
): MemoryProvenance | null {
  const raw = parseMetadata(metadata).memory_provenance;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const source = candidate.source;
  const reason = candidate.reason;
  if (!source || typeof source !== "object" || !reason || typeof reason !== "object") {
    return null;
  }
  const sourceObj = source as Record<string, unknown>;
  const reasonObj = reason as Record<string, unknown>;
  if (
    typeof sourceObj.type !== "string" ||
    typeof sourceObj.conversation_id !== "string" ||
    typeof reasonObj.type !== "string" ||
    typeof reasonObj.text !== "string"
  ) {
    return null;
  }

  const messageIds = stringArray(sourceObj.message_ids);
  const provenance: MemoryProvenance = {
    source: {
      type: sourceObj.type,
      conversation_id: sourceObj.conversation_id,
      ...(messageIds ? { message_ids: messageIds } : {}),
      ...(typeof sourceObj.start_sequence === "number" ? { start_sequence: sourceObj.start_sequence } : {}),
      ...(typeof sourceObj.end_sequence === "number" ? { end_sequence: sourceObj.end_sequence } : {}),
      ...(typeof sourceObj.uri === "string" ? { uri: sourceObj.uri } : {}),
    },
    reason: { type: reasonObj.type, text: reasonObj.text },
    ...(typeof candidate.actor === "string" ? { actor: candidate.actor } : {}),
    ...(typeof candidate.created_at === "string"
      ? { created_at: candidate.created_at }
      : fallbackCreatedAt
        ? { created_at: fallbackCreatedAt }
        : {}),
  };
  return provenance;
}

function normalizeConversation(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    title: (row.title as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    tags: JSON.parse((row.tags as string) || "[]") as string[],
    metadata: JSON.parse((row.metadata as string) || "{}") as Record<string, unknown>,
    message_count: (row.message_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function normalizeMemory(env: Env, row: MessageRow, provenance: MemoryProvenance) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: await loadContent(env, row),
    sequence: row.sequence,
    created_at: row.created_at,
    provenance,
  };
}

export async function traceMemoryById(
  env: Env,
  auth: AuthContext,
  memoryId: string,
) {
  const raw = await getMessageById(env.DB, memoryId, auth.organizationId);
  if (!raw) return null;
  const row = raw as MessageRow;
  const provenance = readMemoryProvenance(row.metadata, row.created_at);
  if (!provenance) return null;

  const memoryConversation = await getConversationById(
    env.DB,
    row.conversation_id,
    auth.organizationId,
  );
  if (!memoryConversation || !canAccessConversation(auth, memoryConversation)) return null;

  const sourceRaw = await getConversationById(
    env.DB,
    provenance.source.conversation_id,
    auth.organizationId,
  );
  const sourceConversation =
    sourceRaw && canAccessConversation(auth, sourceRaw)
      ? normalizeConversation(sourceRaw as Record<string, unknown>)
      : undefined;

  return {
    memory: await normalizeMemory(env, row, provenance),
    provenance,
    ...(sourceConversation ? { source_conversation: sourceConversation } : {}),
  };
}

export async function findMemoriesBySourceConversation(
  env: Env,
  auth: AuthContext,
  sourceConversationId: string,
) {
  const result = await getMessagesByMemorySourceConversation(
    env.DB,
    auth.organizationId,
    sourceConversationId,
  );
  const memories = [];
  for (const raw of result.results as MessageRow[]) {
    const provenance = readMemoryProvenance(raw.metadata, raw.created_at);
    if (!provenance || provenance.source.conversation_id !== sourceConversationId) continue;
    const conversation = await getConversationById(
      env.DB,
      raw.conversation_id,
      auth.organizationId,
    );
    if (!conversation || !canAccessConversation(auth, conversation)) continue;
    memories.push(await normalizeMemory(env, raw, provenance));
  }
  return memories;
}
