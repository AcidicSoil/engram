# Engram

**Memory infrastructure for AI agents.** Store every conversation verbatim. Search by meaning.

[![Website](https://img.shields.io/badge/website-getengram.app-blue)](https://getengram.app)
[![Docs](https://img.shields.io/badge/docs-getengram.app%2Fdocs-blue)](https://getengram.app/docs/getting-started)
[![License](https://img.shields.io/badge/license-BSL--1.1-green)](LICENSE)

Engram is an MCP-native memory server that stores complete, uncompressed conversation transcripts and makes them searchable via semantic search. Connect any MCP-compatible client — Claude Desktop, Claude Code, Cursor, Windsurf, Zed — and your agent remembers everything across sessions.

## Quick start

### Claude Code

```
/plugin marketplace add get-engram/engram
/plugin install engram@engram
```

Restart Claude Code and approve access in the browser. There is no API key to
copy and no config file to edit — the server implements the MCP authorization
flow (RFC 9728 / 8414 / 7591, PKCE), so the client discovers it, registers
itself, and signs you in. A free account is created as part of signing in.

The plugin also ships a skill that tells Claude when to search memory and what
is worth saving, so context accumulates without being asked.

### Any other MCP client

Point it at the remote server and let OAuth handle access:

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp"
    }
  }
}
```

For a client that only speaks stdio, bridge to the remote server with
[mcp-remote](https://www.npmjs.com/package/mcp-remote) — it drives the same
browser OAuth flow, so there is still no key to copy:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.getengram.app/mcp"]
    }
  }
}
```

(An older version of this README suggested `npx @getengram/cli mcp`; the CLI
has no such command and that configuration never worked.)

## AcidicSoil fork: local-first mode

This fork keeps `get-engram/engram` as its upstream baseline and adds a thin local-only runtime for personal use. The local runtime reuses the upstream MCP tools, services, chunking, search logic, and database migrations while adapting D1 to Node 24 SQLite, Workers AI to a localhost LM Studio embedding endpoint, Vectorize to local derived vector storage, and R2 message bodies to inline SQLite. No Engram account, API key, Cloudflare service, or hosted vector database is required for this mode. An optional read-only ABPT adapter exposes ABPT-owned local ChatGPT evidence through the same MCP surface without copying it into Engram or invoking ABPT's live ChatGPT search lane. See [Self-hosting](docs/self-hosting.md#local-personal-mode-acidicsoil-fork). Remaining zero-config inference work is specified in [Local memory runtime completion spec](docs/local-memory-runtime-spec.md).

## How it works

- **Verbatim storage** — every message stored exactly as sent, no summarization or compression
- **Semantic search** — find relevant context by meaning using bge-base-en-v1.5 embeddings
- **MCP-native** — speaks the Model Context Protocol natively, works with any compatible client
- **Multi-tenant** — per-organization isolation, team seats, and API key management

## Architecture

Runs entirely on Cloudflare's developer platform:

- **Workers** — Hono.js API and MCP server
- **D1** — SQLite at the edge for messages and metadata
- **Vectorize** — semantic search index
- **Workers AI** — embedding generation

Read the full [architecture deep-dive](https://getengram.app/docs/architecture).

## MCP tools

The hosted server exposes 8 core memory tools via MCP:

| Tool | Description |
|------|-------------|
| `create_conversation` | Start a new conversation with optional title, tags, metadata |
| `append_messages` | Add messages to an existing conversation |
| `search` | Semantic search across all conversations |
| `get_conversation` | Retrieve a conversation with its messages |
| `list_conversations` | List conversations with filtering and pagination |
| `delete_conversation` | Remove a conversation and its data |
| `memory_status` | Inspect memory usage/status |
| `trace_memory` | Trace a durable memory to its source conversation and creation reason |

See the [API reference](https://getengram.app/docs/api-reference) for full parameters and examples.

## Packages

| Package | Description |
|---------|-------------|
| [`apps/mcp-server`](apps/mcp-server) | Cloudflare Worker — MCP server and REST API |
| [`apps/cli`](apps/cli) | CLI and MCP bridge (`@getengram/cli`) |
| [`packages/sdk`](packages/sdk) | TypeScript SDK (`@getengram/sdk`) |
| [`packages/db`](packages/db) | Database queries and migrations |
| [`packages/shared`](packages/shared) | Shared constants, types, and utilities |

## Integration guides

- [Claude Desktop](https://getengram.app/docs/guides/claude-desktop)
- [Claude Code](https://getengram.app/docs/guides/claude-code)
- [Cursor](https://getengram.app/docs/guides/cursor)
- [Windsurf](https://getengram.app/docs/guides/windsurf)
- [OpenAI Codex CLI](https://getengram.app/docs/guides/codex)
- [Custom agents](https://getengram.app/docs/guides/custom-agents)

## Pricing

| Plan | Price | Messages/month |
|------|-------|----------------|
| Free | $0 | 1,000 |
| Pro | $9/mo | 100,000 |
| Team | $27/seat/mo | 500,000 |
| Enterprise | Custom | Unlimited |

[View pricing](https://getengram.app/pricing)

## Links

- **Website**: [getengram.app](https://getengram.app)
- **Documentation**: [getengram.app/docs](https://getengram.app/docs/getting-started)
- **Blog**: [getengram.app/blog](https://getengram.app/blog)
- **npm**: [@getengram/cli](https://www.npmjs.com/package/@getengram/cli)

## License

Business Source License 1.1 — see [LICENSE](LICENSE) for details.
