import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findMemoriesBySourceConversation,
  traceMemoryById,
} from "../../services/provenance.js";
import { audit } from "../../services/audit.js";
import { loadPrivacy, PRIVACY_BODIES_NOTICE, PRIVACY_CROSS_CONVERSATION_NOTICE } from "../../services/privacy.js";
import { hasScope, scopeError } from "../scopes.js";
import type { Env, AuthContext } from "../../types.js";

const memorySchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    role: z.string(),
    content: z.string().optional(),
    sequence: z.number(),
    created_at: z.string(),
    provenance: z.record(z.unknown()),
  })
  .passthrough();

export function registerTraceMemory(
  server: McpServer,
  env: Env,
  auth: AuthContext,
) {
  server.registerTool(
    "trace_memory",
    {
      description:
        "Trace why a durable memory exists. Pass memory_id to trace a stored memory message back to its source conversation and creation reason, or source_conversation_id to list memories derived from that conversation. Provenance is read from message metadata.memory_provenance.",
      inputSchema: {
        memory_id: z.string().optional().describe("Stored memory message id returned by append_messages"),
        source_conversation_id: z
          .string()
          .optional()
          .describe("Source conversation id to reverse-trace into derived memories"),
      },
      outputSchema: {
        mode: z.enum(["memory", "source_conversation"]),
        memory: memorySchema.optional(),
        provenance: z.record(z.unknown()).optional(),
        source_conversation: z.record(z.unknown()).optional(),
        source_conversation_id: z.string().optional(),
        memories: z.array(memorySchema).optional(),
        total: z.number().optional(),
        privacy_notice: z.string().optional(),
      },
      annotations: {
        title: "Trace memory provenance",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!hasScope(auth, "read")) return scopeError("read");
      if ((params.memory_id ? 1 : 0) + (params.source_conversation_id ? 1 : 0) !== 1) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Provide exactly one of memory_id or source_conversation_id",
            }),
          }],
          isError: true,
        };
      }

      const privacy = await loadPrivacy(env.DB, auth.organizationId);

      if (params.memory_id) {
        const traced = await traceMemoryById(env, auth, params.memory_id);
        if (!traced) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Traceable memory not found" }) }],
            isError: true,
          };
        }
        await audit(
          env.DB,
          auth.organizationId,
          auth.apiKeyId,
          "memory.trace",
          "message",
          params.memory_id,
        );
        const memory = privacy.canReadBodies
          ? traced.memory
          : { ...traced.memory, content: undefined };
        const payload = {
          mode: "memory" as const,
          memory,
          provenance: traced.provenance,
          ...(privacy.canReadCrossConversation && traced.source_conversation
            ? { source_conversation: traced.source_conversation }
            : {}),
          ...(!privacy.canReadBodies ? { privacy_notice: PRIVACY_BODIES_NOTICE } : {}),
          ...(!privacy.canReadCrossConversation
            ? { privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE }
            : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }

      if (!privacy.canReadCrossConversation) {
        const payload = {
          mode: "source_conversation" as const,
          source_conversation_id: params.source_conversation_id!,
          memories: [],
          total: 0,
          privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }

      const found = await findMemoriesBySourceConversation(
        env,
        auth,
        params.source_conversation_id!,
      );
      await audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "memory.reverse_trace",
        "conversation",
        params.source_conversation_id,
        { results: found.length },
      );
      const memories = privacy.canReadBodies
        ? found
        : found.map((memory) => ({ ...memory, content: undefined }));
      const payload = {
        mode: "source_conversation" as const,
        source_conversation_id: params.source_conversation_id!,
        memories,
        total: memories.length,
        ...(!privacy.canReadBodies ? { privacy_notice: PRIVACY_BODIES_NOTICE } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );
}
