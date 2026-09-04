import {
  chunkId,
  chunkMessages,
  summarizeChunk,
  type Message,
} from "@getengram/shared";
import {
  deleteChunksByIds,
  getVectorizeIdsByConversation,
  insertChunks,
} from "@getengram/db";
import { getConversation } from "../src/services/conversation.js";
import { generateEmbeddings } from "../src/services/embedding.js";
import type { AuthContext, Env } from "../src/types.js";

async function loadAllMessages(
  env: Env,
  organizationId: string,
  conversationId: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await getConversation(env, organizationId, conversationId, 500, offset);
    if (!page) throw new Error(`Conversation ${conversationId} not found`);
    messages.push(...page.messages);
    if (page.messages.length < 500) return messages;
  }
}

export async function reindexConversation(
  env: Env,
  auth: AuthContext,
  conversationId: string,
) {
  const messages = await loadAllMessages(env, auth.organizationId, conversationId);
  const vectors = await getVectorizeIdsByConversation(env.DB, conversationId, auth.organizationId);
  const vectorIds = vectors.results.map((row) => row.vectorize_id);
  if (vectorIds.length > 0) await env.VECTORIZE.deleteByIds(vectorIds);

  const chunkRows = await env.DB
    .prepare("SELECT id FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?")
    .bind(conversationId, auth.organizationId)
    .all<{ id: string }>();
  await deleteChunksByIds(
    env.DB,
    chunkRows.results.map((row) => row.id),
    auth.organizationId,
  );

  const chunks = chunkMessages(messages);
  if (chunks.length === 0) return { conversation_id: conversationId, chunks: 0, semantic: true };

  let embeddings: number[][] | null = null;
  try {
    embeddings = await generateEmbeddings(env.AI, chunks.map((chunk) => chunk.text));
  } catch (error) {
    console.error(
      `[engram-local] semantic reindex unavailable; rebuilt FTS only: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const records = chunks.map((chunk) => {
    const id = chunkId(conversationId, chunk.startSequence, chunk.endSequence, chunk.index);
    return {
      id,
      conversationId,
      organizationId: auth.organizationId,
      chunkText: chunk.text,
      chunkSummary: summarizeChunk(chunk.text),
      startSequence: chunk.startSequence,
      endSequence: chunk.endSequence,
      vectorizeId: id,
    };
  });
  await insertChunks(
    env.DB,
    records.map((record) => ({
      id: record.id,
      conversationId: record.conversationId,
      organizationId: record.organizationId,
      chunkText: record.chunkText,
      chunkSummary: record.chunkSummary,
      startSequence: record.startSequence,
      endSequence: record.endSequence,
      vectorizeId: record.vectorizeId,
    })),
  );
  if (embeddings) {
    await env.VECTORIZE.upsert(
      records.map((record, index) => ({
        id: record.vectorizeId,
        values: embeddings[index],
        metadata: {
          organization_id: auth.organizationId,
          conversation_id: conversationId,
          start_sequence: record.startSequence,
          end_sequence: record.endSequence,
        },
      })),
    );
  }
  return { conversation_id: conversationId, chunks: records.length, semantic: Boolean(embeddings) };
}
