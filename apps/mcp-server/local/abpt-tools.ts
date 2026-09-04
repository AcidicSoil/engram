import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_ABPT_API_URL = "http://127.0.0.1:4318";
const REQUEST_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

type QueryValue = string | number | readonly string[] | undefined;

export class AbptLocalClient {
  readonly #baseUrl: URL;

  constructor(baseUrl = DEFAULT_ABPT_API_URL) {
    this.#baseUrl = normalizeLocalAbptUrl(baseUrl);
  }

  listProjects() {
    return this.#get("/api/workspace/projects");
  }

  listConversations(projectId?: string, options: { limit?: number; offset?: number } = {}) {
    const path = projectId
      ? `/api/workspace/projects/${encodeURIComponent(projectId)}/conversations`
      : "/api/workspace/conversations";
    return this.#get(path, { limit: options.limit ?? 100, offset: options.offset ?? 0 });
  }

  getConversation(conversationId: string) {
    return this.#get(`/api/workspace/conversations/${encodeURIComponent(conversationId)}`);
  }

  getEvidence(filter: { projectId?: string; conversationId?: string }) {
    return this.#get("/api/workspace/evidence", filter);
  }

  searchLocal(input: {
    query: string;
    kinds?: readonly string[];
    projectIds?: readonly string[];
    conversationIds?: readonly string[];
    limit?: number;
  }) {
    return this.#get("/api/workspace/search", {
      query: input.query,
      kinds: input.kinds,
      projectIds: input.projectIds,
      conversationIds: input.conversationIds,
      mode: "local",
      limit: input.limit ?? 20,
    });
  }

  grep(input: {
    pattern: string;
    match?: "literal" | "regex";
    projectIds?: readonly string[];
    conversationIds?: readonly string[];
    paths?: readonly string[];
    kinds?: readonly string[];
    output?: "targets" | "content" | "count";
    limit?: number;
  }) {
    return this.#get("/api/workspace/grep", {
      pattern: input.pattern,
      match: input.match ?? "literal",
      projectIds: input.projectIds,
      conversationIds: input.conversationIds,
      paths: input.paths,
      kinds: input.kinds,
      output: input.output ?? "targets",
      limit: input.limit ?? 100,
    });
  }

  status() {
    return this.#get("/api/workspace/status");
  }

  syncStatus() {
    return this.#get("/api/workspace/sync/status");
  }

  async #get(pathname: string, query: Readonly<Record<string, QueryValue>> = {}): Promise<unknown> {
    const url = new URL(pathname, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Local ABPT API unavailable at ${this.#baseUrl.origin}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Local ABPT API returned non-JSON from ${url.pathname}`);
      }
    }
    if (!response.ok) {
      const detail = isRecord(payload) && payload.message != null ? String(payload.message) : "";
      throw new Error(`Local ABPT API ${response.status} for ${url.pathname}${detail ? `: ${detail}` : ""}`);
    }
    return payload;
  }
}

export function registerAbptTools(
  server: McpServer,
  options: { baseUrl?: string } = {},
) {
  const client = new AbptLocalClient(options.baseUrl ?? DEFAULT_ABPT_API_URL);

  server.registerTool(
    "abpt_list_projects",
    {
      description: "List projects from ABPT's authoritative local ChatGPT archive. Read-only; never calls the live ChatGPT lane.",
      inputSchema: {},
      annotations: readOnlyAnnotations("List ABPT projects"),
    },
    async () => result(() => client.listProjects()),
  );

  server.registerTool(
    "abpt_list_conversations",
    {
      description: "List conversations from the authoritative local ABPT archive. Omit project_id to include standalone conversations; provide it to scope to one project.",
      inputSchema: {
        project_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional().default(100),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: readOnlyAnnotations("List ABPT conversations"),
    },
    async ({ project_id, limit, offset }) => result(() => client.listConversations(project_id, { limit, offset })),
  );

  server.registerTool(
    "abpt_get_conversation",
    {
      description: "Retrieve one captured ABPT conversation with its verbatim local messages, files, and evidence pointers.",
      inputSchema: { conversation_id: z.string().min(1) },
      annotations: readOnlyAnnotations("Get ABPT conversation"),
    },
    async ({ conversation_id }) => result(() => client.getConversation(conversation_id)),
  );

  server.registerTool(
    "abpt_get_evidence",
    {
      description: "Retrieve authoritative local evidence references for an ABPT project and/or conversation.",
      inputSchema: {
        project_id: z.string().min(1).optional(),
        conversation_id: z.string().min(1).optional(),
      },
      annotations: readOnlyAnnotations("Get ABPT evidence"),
    },
    async ({ project_id, conversation_id }) => {
      if (!project_id && !conversation_id) return toolError("project_id or conversation_id is required");
      return result(() => client.getEvidence({ projectId: project_id, conversationId: conversation_id }));
    },
  );

  server.registerTool(
    "abpt_search",
    {
      description: "Search only ABPT's persisted local corpus index. The live ChatGPT search lane is deliberately disabled on this mcporter surface.",
      inputSchema: {
        query: z.string().trim().min(1),
        kinds: z.array(z.enum(["conversation", "project", "message", "file", "document", "image"])).min(1).optional(),
        project_ids: z.array(z.string().min(1)).min(1).optional(),
        conversation_ids: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: readOnlyAnnotations("Search local ABPT archive"),
    },
    async ({ query, kinds, project_ids, conversation_ids, limit }) => result(() => client.searchLocal({
      query,
      kinds,
      projectIds: project_ids,
      conversationIds: conversation_ids,
      limit,
    })),
  );

  server.registerTool(
    "abpt_grep",
    {
      description: "Run bounded literal or regex verification over already captured local ABPT evidence.",
      inputSchema: {
        pattern: z.string().min(1),
        match: z.enum(["literal", "regex"]).optional().default("literal"),
        project_ids: z.array(z.string().min(1)).min(1).optional(),
        conversation_ids: z.array(z.string().min(1)).min(1).optional(),
        paths: z.array(z.string().min(1)).min(1).optional(),
        kinds: z.array(z.enum(["message", "file", "document", "instruction"])).min(1).optional(),
        output: z.enum(["targets", "content", "count"]).optional().default("targets"),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: readOnlyAnnotations("Grep local ABPT evidence"),
    },
    async ({ pattern, match, project_ids, conversation_ids, paths, kinds, output, limit }) => {
      if (paths && (project_ids || conversation_ids)) {
        return toolError("abpt_grep cannot combine entity IDs with explicit paths");
      }
      return result(() => client.grep({
        pattern,
        match,
        projectIds: project_ids,
        conversationIds: conversation_ids,
        paths,
        kinds,
        output,
        limit,
      }));
    },
  );

  server.registerTool(
    "abpt_status",
    {
      description: "Read ABPT local archive status, including the canonical data root and capture/index state.",
      inputSchema: {},
      annotations: readOnlyAnnotations("ABPT archive status"),
    },
    async () => result(() => client.status()),
  );

  server.registerTool(
    "abpt_sync_status",
    {
      description: "Read ABPT's local archive synchronization status without starting a sync or contacting ChatGPT.",
      inputSchema: {},
      annotations: readOnlyAnnotations("ABPT sync status"),
    },
    async () => result(() => client.syncStatus()),
  );
}

export function normalizeLocalAbptUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported ABPT API protocol: ${url.protocol}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`ABPT local MCP adapter only permits loopback endpoints; got ${url.hostname}`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url;
}

function readOnlyAnnotations(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
}

async function result(work: () => Promise<unknown>) {
  try {
    const payload = await work();
    const structuredContent = isRecord(payload) ? payload : undefined;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      ...(structuredContent ? { structuredContent } : {}),
    };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}
