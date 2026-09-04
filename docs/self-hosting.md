# Self-Hosting


## Local personal mode (AcidicSoil fork)

`AcidicSoil/engram` includes a stdio MCP runtime for a single-user local machine. It reuses the upstream Engram MCP tools, services, chunking/search behavior, and SQL migrations. A thin adapter maps D1 to Node 24 SQLite, Workers AI to an OpenAI-compatible localhost embedding endpoint, Vectorize to local derived vector storage, and R2 message bodies to inline SQLite. SQLite FTS5 provides keyword retrieval; semantic retrieval falls back to FTS-only when the embedding endpoint is unavailable.

The default database is `~/.local/share/engram/local.db`. The runtime creates it with mode `0600`. Derived chunks and embeddings can be rebuilt from canonical conversation/message rows with the `reindex` MCP tool. The local migrator applies the upstream migrations unchanged; before upstream migration `0003_team_tier.sql` it supplies the historical `organizations.email` column that upstream expects from an earlier production deploy.

From the fork root:

```bash
mise exec node@24 pnpm@9.15.0 -- pnpm install --frozen-lockfile
mcporter config add engram-local \
  --command "$HOME/.local/bin/mise" \
  --description "Local-first Engram memory" \
  --env ENGRAM_LOCAL_DB="$HOME/.local/share/engram/local.db" \
  --env ENGRAM_LOCAL_EMBEDDING_URL="http://127.0.0.1:1234/v1/embeddings" \
  --env ENGRAM_LOCAL_EMBEDDING_MODEL="text-embedding-nomic-embed-text-v1.5" \
  --scope home -- \
  exec node@24 pnpm@9.15.0 -- pnpm --dir "$(pwd)" --filter @getengram/mcp-server exec tsx local/server.ts
```

Verify discovery and the local store:

```bash
mcporter list engram-local --status --json
mcporter list engram-local --brief
mcporter call engram-local.memory_status --output json

# Full round-trip proof; creates and removes only its own verification records
bash apps/mcp-server/local/verify-mcporter.sh
```

The local server always exposes the nine Engram-owned tools: `create_conversation`, `append_messages`, `search`, `get_conversation`, `list_conversations`, `delete_conversation`, `trace_memory`, `reindex`, and `memory_status`.

It also registers an optional read-only ABPT source adapter: `abpt_list_projects`, `abpt_list_conversations`, `abpt_get_conversation`, `abpt_get_evidence`, `abpt_search`, `abpt_grep`, `abpt_status`, and `abpt_sync_status`. These tools call only the loopback ABPT API (`http://127.0.0.1:4318` by default). `abpt_search` always sends `mode=local`; this MCP surface cannot select ABPT's live ChatGPT lane. If ABPT is stopped or unavailable, only the `abpt_*` calls fail; Engram memory, search, provenance, and reindex remain independent. Override the loopback endpoint with `ABPT_API_URL` when needed.

For a curated memory derived from another conversation, put provenance in `messages[].metadata.memory_provenance`:

```json
{
  "source": {
    "type": "chatgpt",
    "conversation_id": "conv_source",
    "message_ids": ["msg_source"]
  },
  "reason": {
    "type": "explicit_user_request",
    "text": "The user explicitly asked to preserve this as a durable rule."
  },
  "actor": "chatgpt"
}
```

Use `trace_memory` with `memory_id` to move from a durable memory back to its source and reason. Use `source_conversation_id` to list durable memories derived from a conversation.

## Cloudflare self-hosting (upstream mode)

Engram runs entirely on Cloudflare's developer platform. You can deploy your own instance with a free Cloudflare account.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [pnpm](https://pnpm.io) 9+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/get-engram/engram.git
cd engram
pnpm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Create D1 database

```bash
wrangler d1 create engram-db
```

Copy the `database_id` from the output and update `apps/mcp-server/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "engram-db"
database_id = "your-database-id-here"
```

### 4. Apply migrations

```bash
# Local development
cd apps/mcp-server
npm run db:migrate:local

# Production
wrangler d1 migrations apply engram-db --remote
```

### 5. Create Vectorize index

```bash
wrangler vectorize create engram-vectors --dimensions=768 --metric=cosine
```

### 6. Generate an API key

```bash
cd apps/mcp-server
npm run seed
```

This outputs SQL statements to create an organization and API key. Run them against your D1 database:

```bash
wrangler d1 execute engram-db --remote --command="INSERT INTO ..."
```

Save the raw API key — it's shown once and cannot be retrieved.

### 7. Deploy

```bash
cd apps/mcp-server
wrangler deploy
```

Your Engram instance is now live at `https://engram-mcp-server.<your-subdomain>.workers.dev`.

## Local Development

```bash
# From the repo root
pnpm dev

# Or from apps/mcp-server
npm run dev
```

This starts a local server at `http://localhost:8787`. The `/health` endpoint returns service status.

To test with an MCP client, point it at `http://localhost:8787/mcp` with your API key.

## Running Tests

```bash
# All packages
pnpm test

# Just the MCP server
cd apps/mcp-server && npm test
```

## Type Checking

```bash
pnpm typecheck
```

## Infrastructure

| Service | What it does | Free tier limits |
|---------|-------------|-----------------|
| **Workers** | Runs the MCP server at the edge | 100K requests/day |
| **D1** | SQLite database for conversations & messages | 5GB storage |
| **Vectorize** | Vector search index for semantic search | 5M vectors |
| **Workers AI** | Generates embeddings (`bge-base-en-v1.5`) | Unlimited (free model) |
