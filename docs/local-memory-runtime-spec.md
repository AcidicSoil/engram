# Local memory runtime completion spec

Status: implemented and verified on 2026-09-16
Scope: `AcidicSoil/engram` local personal mode only
Feature branch: `feat/local-memory-provenance`

Reference state used for this plan:

- feature head: `c9daaab`
- current local `main`: `1e69e17`
- feature divergence: 4 feature-only commits and 21 main-only commits
- qmd reference: `tobi/qmd` main at `04e4dbd8245c527a88f1a8f0bda547aef9ca81fb`, package version `2.8.3`

Implementation verification:

- default MCP server test suite: 264/264 passing
- TypeScript typecheck: passing
- Cloudflare Worker dry-run build: passing, with no `node-llama-cpp` symbols in the Worker output
- cold-cache real GGUF runtime: automatic model acquisition reached `ready`
- warm-cache networkless restart: `bubblewrap --unshare-net` reached `ready` and passed semantic retrieval
- real mcporter round trip: keyword search, semantic search, provenance, pagination, reindex, and cleanup all passing

## Decision

Replace the local LM Studio embedding dependency with an embedded `node-llama-cpp` runtime patterned after qmd.

The local Engram MCP must run with no model server and no embedding configuration. On first use it acquires its default GGUF embedding model, caches it under the user's cache directory, chooses an available compute backend, and keeps working from that cache on later runs.

SQLite remains the source of truth. Embeddings remain derived data that Engram can delete and rebuild.

Do not add qmd's generation, query-expansion, or reranking features. Engram needs its model-management pattern, not another search engine.
## Product contract

A finished local runtime has these properties:

1. `engram-local` starts without LM Studio, Ollama, llama-server, or another separately managed daemon.
2. The normal setup does not require embedding environment variables.
3. A missing default model downloads automatically and is cached locally.
4. A warm cache works without network access.
5. Message and chunk persistence never depends on the embedding runtime being healthy.
6. FTS remains available while the model downloads, fails, or is disabled.
7. Semantic indexing converges automatically after a temporary embedding failure.
8. Engram detects an embedding-model change and rebuilds incompatible vectors.
9. The hosted Cloudflare runtime keeps its existing Workers AI behavior.
10. ABPT stays read-only and independent. Engram does not copy the ABPT archive into its memory database.

## Current state and gaps

The fork already has the hard parts of local persistence: Node 24 SQLite, inline content, SQLite-backed vectors, FTS, provenance tracing, `reindex`, and the read-only ABPT adapter.

The remaining problems are operational and lifecycle problems rather than a need for another storage design.

- `local/server.ts` defaults to `http://127.0.0.1:1234/v1/embeddings`, so semantic search depends on LM Studio being installed, running, and configured with the expected model.
- `append_messages` generates embeddings before inserting `conversation_chunks`. When embedding fails, the new chunks are missing from FTS too. The current FTS fallback therefore does not cover newly appended data until `reindex` runs.
- `local_vectors` does not record a model fingerprint. Vectors made by different embedding models can coexist even though their spaces are not comparable.
- The feature branch is behind current `main`, including recent security, OAuth, tool-description, and organization-isolation changes. Implementation must start by integrating current `main`.
- The local database currently contains no durable user conversations. The verification scripts proved the runtime, then deleted their test records. Operational adoption is still unfinished.

## What qmd does that we should copy

qmd uses `node-llama-cpp` directly inside its Node process. Its current package pins `node-llama-cpp` `3.20.0`.

Its model layer provides the behavior Engram needs:

- built-in Hugging Face GGUF model URIs
- automatic model resolution and download through `resolveModelFile`
- a user-owned cache at `~/.cache/qmd/models` or the `XDG_CACHE_HOME` equivalent
- GGUF header validation before load
- cache refresh support and remote ETag tracking
- automatic GPU selection with explicit CPU and backend overrides for troubleshooting
- lazy native initialization instead of requiring a model daemon at process startup
- explicit context disposal after inactivity while keeping reusable model state warm
- environment overrides as escape hatches rather than required setup

qmd currently defaults embedding to:

`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`

Engram should use the same model as its initial local default unless implementation-time retrieval-quality tests expose a regression against the current local Nomic setup.
## Architecture choice

Three viable shapes were considered.

| Option | Shape | Cost |
|---|---|---|
| Embedded llama.cpp | `engram-local` loads `node-llama-cpp` and owns model download, cache, and lifecycle | One process, no user-managed service. Native dependency stays local-only. |
| Managed sidecar | Engram starts and supervises Ollama or llama-server itself | Adds process supervision, ports, readiness, upgrades, and another failure boundary. |
| Keep external endpoint | Continue calling an OpenAI-compatible LM Studio endpoint | Smallest code change, but preserves the exact setup and reliability problem this work is meant to remove. |

Use the embedded llama.cpp option.

Do not depend on qmd as a library. Its indexing, generation, reranking, and CLI concerns are unrelated to Engram. Copy the small runtime pattern and depend on `node-llama-cpp` directly.

## Runtime boundary

Keep the native model code behind one local-only interface. Hosted code must not import `node-llama-cpp`.

The interface should own:

```ts
type EmbeddingPurpose = "query" | "document";

type LocalEmbeddingRuntime = {
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
  status(): EmbeddingRuntimeStatus;
  fingerprint(): Promise<EmbeddingFingerprint>;
  dispose(): Promise<void>;
};
```
`EmbeddingFingerprint` must include enough information to decide whether stored vectors are compatible with the active runtime. At minimum it contains the resolved model URI or local path, a stable file identity, embedding dimensions, and the local input-format version.

The existing fake Workers AI binding can remain as the adapter into upstream services, but it must call this runtime instead of HTTP. Do not teach hosted `Env.AI` about llama.cpp.

The embedding service should distinguish query embeddings from document embeddings. The hosted Workers AI adapter may ignore that distinction. The local model adapter uses it when its model requires different retrieval prompts.

## Model acquisition and lifecycle

Use these defaults:

- model cache: `$XDG_CACHE_HOME/engram/models`, otherwise `~/.cache/engram/models`
- embedding model: the pinned default GGUF URI above
- compute backend: automatic
- context lifecycle: lazy creation, dispose after about five minutes idle
- model lifecycle: keep the loaded model while the MCP process is alive unless memory pressure or a backend error requires reload

On startup, the MCP server must become discoverable without waiting for a model download. Start model preparation asynchronously.

If the model is missing, download it automatically. Validate the resulting file as GGUF before loading it. A confirmed HTML or invalid download may be deleted and retried. An unreadable file must not be deleted merely because a read failed.

If automatic GPU initialization fails, retry with CPU before declaring semantic inference unavailable. Write diagnostics to stderr so stdio JSON output remains clean.

After a successful first download, semantic search must work with the network disconnected.
## Make canonical writes independent of embeddings

Change the append path so this order is invariant in both hosted and local modes:

1. Store the messages.
2. Build deterministic chunks.
3. Insert or upsert `conversation_chunks` so FTS sees them.
4. Attempt document embeddings.
5. Upsert semantic vectors when embeddings succeed.

If steps 4 or 5 fail, `append_messages` still succeeds because the canonical memory and FTS index already exist.

Do not create a durable job queue just for this. The database already contains enough information to discover incomplete derived state.

When the local embedding runtime becomes ready, find conversations whose chunks do not have compatible vectors and reindex them. Bound the work and process conversations sequentially so startup does not saturate the machine.

## Track embedding compatibility

Add local-only embedding state in SQLite. Keep it separate from upstream migrations so upstream schema changes can continue to apply unchanged.

Persist:

- active model fingerprint
- indexed model fingerprint
- embedding dimensions
- last successful semantic-index completion time

Also store the model fingerprint in each local vector's metadata.

If the active fingerprint differs from the indexed fingerprint, semantic query must not mix the old vectors with the new query vector. Mark semantic state stale, clear or ignore incompatible vectors, and rebuild from canonical chunks.
`reindex` remains the manual repair command, but normal operation must not require the user to remember to run it.

## Search behavior

FTS always runs.

Semantic search runs only when the local embedding runtime is ready and the stored vectors match the active model fingerprint. Search continues with FTS-only results while the model is downloading, the semantic index is stale, or local inference has failed.

Do not fail an MCP search because semantic inference is unavailable.

Expose the semantic state through `memory_status` so an agent can distinguish these states without reading logs:

- `ready`
- `preparing`
- `reindexing`
- `degraded`

Include the active model, cache path, backend, vector count, and whether a rebuild is pending. Do not add user-facing configuration steps for the normal case.

## Configuration

Normal mcporter configuration must contain only the database path and command needed to start `engram-local`.

Remove these required settings:

- `ENGRAM_LOCAL_EMBEDDING_URL`
- `ENGRAM_LOCAL_EMBEDDING_MODEL`

Keep only advanced escape hatches, with defaults that require no configuration:
- `ENGRAM_LOCAL_EMBED_MODEL` for a different GGUF URI or local model path
- `ENGRAM_LOCAL_MODEL_CACHE` for a different cache directory
- `ENGRAM_LOCAL_LLAMA_GPU` for explicit `cuda`, `vulkan`, `metal`, or CPU selection when automatic detection is wrong

Do not keep the LM Studio HTTP path as a compatibility layer. If an external embedding-provider mode is wanted later, design it as a separate provider with its own explicit contract.

## Implementation phases

### Phase 0: integrate current main

Merge current `main` into `feat/local-memory-provenance` before changing the inference layer.

Resolve conflicts against the current hosted implementation rather than restoring stale feature-branch copies. Re-run the existing hosted and local tests before starting new work. This establishes whether any failures come from branch integration or from the new runtime.

### Phase 1: define the inference contract with tests

Write tests before implementation for:

- default model and cache resolution
- environment overrides
- query versus document input formatting
- GGUF validation behavior
- automatic GPU to CPU fallback
- clean disposal and idle context recreation

Use fakes for normal unit tests. Do not make the standard test suite download a model.
### Phase 2: replace the LM Studio adapter

Implement the local embedding runtime with `node-llama-cpp`.

Use qmd's model-acquisition behavior as the reference: a pinned GGUF default, `resolveModelFile`, a private cache directory, file validation, and automatic backend selection. Keep all native imports under the local runtime path so the Cloudflare Worker bundle never imports them.

Adapt the existing local AI binding to call the runtime in-process. Delete the HTTP embedding client and the localhost endpoint defaults.

### Phase 3: make indexing self-healing

Move chunk persistence ahead of semantic indexing.

Add the local embedding-state record and vector fingerprint metadata. On runtime readiness, detect missing or stale vectors and rebuild only the affected conversations unless the model fingerprint changed, in which case rebuild the full local semantic index.

Make repeated recovery runs idempotent. Killing the process during a rebuild and restarting it must converge to the same final index.

### Phase 4: wire status and operations

Extend `memory_status` with local semantic-runtime state without changing the hosted response contract unnecessarily. If local-only fields would complicate the shared tool contract, place them under a clearly optional `local` object.

Update `verify-mcporter.sh` so its main proof runs with no LM Studio process and no embedding endpoint variables.

Add one explicit real-model verification command that is not part of normal CI. It may download the pinned model into a temporary or user cache and prove semantic retrieval end to end.
### Phase 5: update user-level wiring

After the code passes verification, update `~/.mcporter/mcporter.json` for `engram-local`:

- remove the LM Studio URL and model variables
- keep `ENGRAM_LOCAL_DB`
- keep the existing fork command and keep-alive lifecycle

Do not change the user's database path. Do not replace or reset `~/.local/share/engram/local.db`.

Add or update agent-routing guidance so durable memory writes target the local `engram-local` MCP when that is the intended memory store. Keep ABPT retrieval separate. Do not bulk-import ABPT into Engram as part of this work.

Store one non-test durable memory after deployment, restart the MCP process, and prove that both retrieval and provenance survive restart. This closes the current gap where the runtime is verified but the local database contains no lasting memories.

### Phase 6: documentation and merge

Update the fork README and `docs/self-hosting.md` to describe the zero-config runtime only after it works.

Remove LM Studio setup instructions. Document the cache location, automatic model download, offline-after-cache behavior, advanced overrides, and how to inspect model/index status.

Run the full verification gate before merging the feature branch.

## Test matrix

The implementation is not complete until these cases pass:
- Clean machine state: no LM Studio or Ollama process, no embedding URL variables. `engram-local` starts and lists tools.
- Cold model cache: MCP discovery returns while the model prepares. The model downloads automatically and reaches `ready`.
- Warm model cache: restart without network access. Semantic search still works.
- CPU-only machine: runtime loads on CPU without user configuration.
- GPU initialization failure: runtime retries on CPU and records the selected backend.
- Embedding outage during append: messages and chunks persist, FTS finds the new content, and the append call succeeds.
- Interrupted reindex: restart resumes or repeats safely and converges without duplicate chunks or vectors.
- Model change: old vectors are never queried with the new model. Automatic rebuild produces a single compatible vector set.
- Corrupt cached download: confirmed invalid GGUF is rejected and can be reacquired.
- Temporarily unreadable cache file: runtime reports the read failure without deleting the file.
- ABPT unavailable: only `abpt_*` tools fail. Engram memory and local search continue.
- Hosted build: Cloudflare Worker typecheck, tests, and dry-run build still pass without native llama.cpp entering the Worker bundle.
- Persistence: a real durable memory remains searchable with provenance after MCP process restart.

## Likely files

Keep the change narrow. Expected files are:

- `apps/mcp-server/local/server.ts`
- `apps/mcp-server/local/local-bindings.ts`
- `apps/mcp-server/local/embedding-runtime.ts` as the main new runtime module
- `apps/mcp-server/local/sqlite-d1.ts`
- `apps/mcp-server/local/reindex.ts`
- `apps/mcp-server/local/local.test.ts`
- `apps/mcp-server/local/verify-mcporter.sh`
- `apps/mcp-server/src/services/embedding.ts`
- `apps/mcp-server/src/services/conversation.ts`
- `apps/mcp-server/src/services/search.ts` only if the query/document purpose cannot stay inside the embedding service
- `apps/mcp-server/package.json` and `pnpm-lock.yaml` for the local native dependency
- `README.md`
- `docs/self-hosting.md`

Do not refactor unrelated hosted services or move the local runtime into a new application unless the Worker build proves that the native dependency cannot remain isolated. Start with the smaller design and let a failing build justify a larger package boundary.

## Verification gate

Run at minimum:

```bash
pnpm --filter @getengram/mcp-server test
pnpm --filter @getengram/mcp-server typecheck
pnpm --filter @getengram/mcp-server build
bash apps/mcp-server/local/verify-mcporter.sh
```

Then run the real-model proof with LM Studio and Ollama stopped.

Inspect the built Worker output or dependency graph to prove `node-llama-cpp` is not bundled into the Cloudflare Worker entry point.

Finally inspect the actual SQLite database. Confirm that the durable smoke-test conversation, its messages, chunks, compatible vectors, and provenance exist after restart.

## Definition of done

This work is done when a user can clone the fork, install dependencies, register `engram-local`, and use durable semantic memory without installing or configuring a separate model application.

The first model acquisition may take time and network bandwidth, but it requires no manual model selection or server setup. After the cache is warm, the runtime works offline.

## qmd reference files

Use these as implementation references, not dependencies:

- `https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/llm.ts`
- `https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/package.json`
- `https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/README.md`

The relevant qmd behavior is model ownership: built-in model defaults, automatic acquisition, cache management, native backend selection, file validation, and lifecycle management.