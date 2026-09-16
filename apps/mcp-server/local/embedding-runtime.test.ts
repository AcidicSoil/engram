import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EMBED_MODEL_URI,
  EMBEDDING_INPUT_FORMAT_VERSION,
  LocalEmbeddingRuntime,
  createNodeLlamaBindings,
  formatEmbeddingText,
  inspectGgufFile,
  resolveLocalEmbeddingConfig,
} from "./embedding-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-embedding-runtime-"));
  tempDirs.push(dir);
  return dir;
}
describe("local embedding config", () => {
  test("uses zero-config defaults", () => {
    const config = resolveLocalEmbeddingConfig({}, "/home/tester");
    expect(config.modelUri).toBe(DEFAULT_EMBED_MODEL_URI);
    expect(config.cacheDir).toBe("/home/tester/.cache/engram/models");
    expect(config.gpu).toBe("auto");
  });

  test("honors advanced overrides", () => {
    const config = resolveLocalEmbeddingConfig(
      {
        XDG_CACHE_HOME: "/var/cache/me",
        ENGRAM_LOCAL_EMBED_MODEL: "/models/custom.gguf",
        ENGRAM_LOCAL_MODEL_CACHE: "/models/cache",
        ENGRAM_LOCAL_LLAMA_GPU: "cpu",
      },
      "/home/tester",
    );
    expect(config.modelUri).toBe("/models/custom.gguf");
    expect(config.cacheDir).toBe("/models/cache");
    expect(config.gpu).toBe(false);
  });
});

describe("embedding input formatting", () => {
  test("formats query and document inputs differently", () => {
    expect(formatEmbeddingText("rollback plan", "query")).toBe(
      "task: search result | query: rollback plan",
    );
    expect(formatEmbeddingText("rollback plan", "document")).toBe(
      "title: none | text: rollback plan",
    );
    expect(EMBEDDING_INPUT_FORMAT_VERSION).toBeGreaterThan(0);
  });
});
describe("GGUF validation", () => {
  test("accepts GGUF magic and rejects HTML downloads", () => {
    const dir = tempDir();
    const valid = join(dir, "valid.gguf");
    const html = join(dir, "html.gguf");
    writeFileSync(valid, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(32)]));
    writeFileSync(html, "<!doctype html><html>proxy error</html>");

    expect(inspectGgufFile(valid).kind).toBe("gguf");
    expect(inspectGgufFile(valid).valid).toBe(true);
    expect(inspectGgufFile(html).kind).toBe("html");
    expect(inspectGgufFile(html).valid).toBe(false);
  });
});

type FakeContext = {
  getEmbeddingFor: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

function fakeNative(modelPath: string, failAuto = false) {
  const contexts: FakeContext[] = [];
  const createEmbeddingContext = vi.fn(async () => {
    const context = {
      getEmbeddingFor: vi.fn(async (text: string) => ({
        vector: Float32Array.from([text.length, 2, 3]),
      })),
      dispose: vi.fn(async () => {}),
    };
    contexts.push(context);
    return context;
  });
  const model = {
    createEmbeddingContext,
    dispose: vi.fn(async () => {}),
  };
  const cpuLlama = {
    gpu: false as const,
    loadModel: vi.fn(async () => model),
    dispose: vi.fn(async () => {}),
  };
  const gpuLlama = {
    gpu: "cuda" as const,
    loadModel: vi.fn(async () => model),
    dispose: vi.fn(async () => {}),
  };
  const getLlama = vi.fn(async ({ gpu }: { gpu: string | false }) => {
    if (failAuto && gpu === "auto") throw new Error("gpu init failed");
    return gpu === false ? cpuLlama : gpuLlama;
  });
  return {
    bindings: {
      getLlama,
      resolveModelFile: vi.fn(async () => modelPath),
    },
    contexts,
    createEmbeddingContext,
    getLlama,
    model,
    cpuLlama,
    gpuLlama,
  };
}

describe("node-llama-cpp boundary", () => {
  test("never replaces MCP stdout while native initialization is pending", async () => {
    let release!: (value: unknown) => void;
    const nativeLlama = {
      gpu: "cuda",
      loadModel: vi.fn(),
      dispose: vi.fn(),
    };
    const getLlama = vi.fn(() => new Promise((resolve) => {
      release = resolve;
    }));
    const native = {
      getLlama,
      resolveModelFile: vi.fn(),
    } as unknown as typeof import("node-llama-cpp");
    const bindings = createNodeLlamaBindings(native);
    const originalStdoutWrite = process.stdout.write;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const pending = bindings.getLlama({ gpu: "auto" });
    await Promise.resolve();

    expect(process.stdout.write).toBe(originalStdoutWrite);
    const options = getLlama.mock.calls[0]?.[0] as {
      progressLogs?: boolean | "stderr";
      logger?: (level: number, message: string) => void;
    };
    expect(options.progressLogs).toBe("stderr");
    options.logger?.(0, "native log");
    expect(stderrWrite).toHaveBeenCalledWith("native log");

    release(nativeLlama);
    await pending;
    expect(process.stdout.write).toBe(originalStdoutWrite);
    stderrWrite.mockRestore();
  });
});

describe("LocalEmbeddingRuntime", () => {
  test("falls back from automatic GPU initialization to CPU", async () => {
    const dir = tempDir();
    const modelPath = join(dir, "model.gguf");
    writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
    const fake = fakeNative(modelPath, true);
    const runtime = new LocalEmbeddingRuntime({
      config: { modelUri: "fake:model", cacheDir: dir, gpu: "auto" },
      native: fake.bindings,
    });

    const vectors = await runtime.embed(["hello"], "document");
    expect(vectors).toHaveLength(1);
    expect(fake.getLlama).toHaveBeenNthCalledWith(1, { gpu: "auto" });
    expect(fake.getLlama).toHaveBeenNthCalledWith(2, { gpu: false });
    expect(runtime.status()).toMatchObject({ state: "ready", backend: "cpu", dimensions: 3 });
    await runtime.dispose();
  });
  test("disposes idle embedding context and recreates it on demand", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const modelPath = join(dir, "model.gguf");
    writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
    const fake = fakeNative(modelPath);
    const runtime = new LocalEmbeddingRuntime({
      config: { modelUri: "fake:model", cacheDir: dir, gpu: false },
      native: fake.bindings,
      idleMs: 100,
    });

    await runtime.embed(["first"], "document");
    expect(fake.createEmbeddingContext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(fake.contexts[0]?.dispose).toHaveBeenCalledTimes(1);

    await runtime.embed(["second"], "query");
    expect(fake.createEmbeddingContext).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  test("fingerprint includes model file identity, dimensions, and format version", async () => {
    const dir = tempDir();
    const modelPath = join(dir, "model.gguf");
    writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64, 7)]));
    const fake = fakeNative(modelPath);
    const runtime = new LocalEmbeddingRuntime({
      config: { modelUri: "fake:model", cacheDir: dir, gpu: false },
      native: fake.bindings,
    });

    await runtime.prepare();
    const fingerprint = await runtime.fingerprint();
    expect(fingerprint.modelUri).toBe("fake:model");
    expect(fingerprint.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint.dimensions).toBe(3);
    expect(fingerprint.inputFormatVersion).toBe(EMBEDDING_INPUT_FORMAT_VERSION);
    expect(fingerprint.id).toMatch(/^[a-f0-9]{64}$/);
    await runtime.dispose();
  });
});
