import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_EMBED_MODEL_URI =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
export const EMBEDDING_INPUT_FORMAT_VERSION = 1;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export type EmbeddingPurpose = "query" | "document";
export type LocalGpuMode = "auto" | "cuda" | "vulkan" | "metal" | false;

export type LocalEmbeddingConfig = {
  modelUri: string;
  cacheDir: string;
  gpu: LocalGpuMode;
};export type EmbeddingFingerprint = {
  id: string;
  modelUri: string;
  modelPath: string;
  fileSha256: string;
  dimensions: number;
  inputFormatVersion: number;
};

export type EmbeddingRuntimeStatus =
  | {
      state: "preparing";
      model: string;
      cacheDir: string;
    }
  | {
      state: "ready";
      model: string;
      cacheDir: string;
      modelPath: string;
      backend: string;
      dimensions: number;
      fingerprint: string;
    }
  | {
      state: "degraded";
      model: string;
      cacheDir: string;
      error: string;
    };
type NativeEmbeddingContext = {
  getEmbeddingFor(text: string): Promise<{ vector: Iterable<number> }>;
  dispose(): void | Promise<void>;
};

type NativeModel = {
  createEmbeddingContext(): Promise<NativeEmbeddingContext>;
  dispose(): void | Promise<void>;
};

type NativeLlama = {
  readonly gpu: string | false;
  loadModel(options: { modelPath: string }): Promise<NativeModel>;
  dispose(): void | Promise<void>;
};

export type LocalLlamaBindings = {
  getLlama(options: { gpu: LocalGpuMode }): Promise<NativeLlama>;
  resolveModelFile(
    model: string,
    options: { directory: string; cli: boolean },
  ): Promise<string>;
};

type RuntimeOptions = {
  config?: LocalEmbeddingConfig;
  native?: LocalLlamaBindings;
  idleMs?: number;
};
function resolveGpu(value?: string): LocalGpuMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto") return "auto";
  if (["cpu", "false", "off", "none", "0"].includes(normalized)) return false;
  if (normalized === "cuda" || normalized === "vulkan" || normalized === "metal") {
    return normalized;
  }
  process.stderr.write(
    `[engram-local] ignoring invalid ENGRAM_LOCAL_LLAMA_GPU=${JSON.stringify(value)}; using auto\n`,
  );
  return "auto";
}

export function resolveLocalEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): LocalEmbeddingConfig {
  const cacheHome = env.XDG_CACHE_HOME || join(home, ".cache");
  return {
    modelUri: env.ENGRAM_LOCAL_EMBED_MODEL || DEFAULT_EMBED_MODEL_URI,
    cacheDir: env.ENGRAM_LOCAL_MODEL_CACHE || join(cacheHome, "engram", "models"),
    gpu: resolveGpu(env.ENGRAM_LOCAL_LLAMA_GPU),
  };
}

export function formatEmbeddingText(text: string, purpose: EmbeddingPurpose): string {
  return purpose === "query"
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}
export type GgufFileInspection = {
  exists: boolean;
  valid: boolean;
  kind: "missing" | "gguf" | "html" | "invalid" | "unreadable";
  sizeBytes?: number;
  magic?: string;
  details: string;
};

const GGUF_MAGIC = Buffer.from("GGUF");

function printableMagic(header: Buffer): string {
  const text = header.toString("utf8");
  return /^[\x20-\x7e]{1,4}$/.test(text) ? text : `0x${header.toString("hex")}`;
}

export function inspectGgufFile(filePath: string): GgufFileInspection {
  if (!existsSync(filePath)) {
    return { exists: false, valid: false, kind: "missing", details: "file does not exist" };
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    const sniff = Buffer.alloc(512);
    try {
      readSync(fd, sniff, 0, sniff.length, 0);
    } finally {
      closeSync(fd);
    }
    const header = sniff.subarray(0, 4);
    if (header.equals(GGUF_MAGIC)) {
      return {
        exists: true,
        valid: true,
        kind: "gguf",
        sizeBytes,
        magic: "GGUF",
        details: "valid GGUF",
      };
    }

    const magic = printableMagic(header);
    const body = sniff.toString("utf8").toLowerCase();
    if (body.includes("<!doctype") || body.includes("<html")) {
      return {
        exists: true,
        valid: false,
        kind: "html",
        sizeBytes,
        magic,
        details: "HTML page, not a GGUF model",
      };
    }
    return {
      exists: true,
      valid: false,
      kind: "invalid",
      sizeBytes,
      magic,
      details: `expected GGUF magic, got ${magic}`,
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      kind: "unreadable",
      sizeBytes,
      details: `cannot read model file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

type StdoutWrite = typeof process.stdout.write;
let nativeStdoutRedirectDepth = 0;
let originalStdoutWrite: StdoutWrite | null = null;

async function withNativeStdoutOnStderr<T>(work: () => Promise<T>): Promise<T> {
  if (nativeStdoutRedirectDepth === 0) {
    originalStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;
    process.stdout.write = process.stderr.write.bind(process.stderr) as StdoutWrite;
  }
  nativeStdoutRedirectDepth++;
  try {
    return await work();
  } finally {
    nativeStdoutRedirectDepth--;
    if (nativeStdoutRedirectDepth === 0 && originalStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
      originalStdoutWrite = null;
    }
  }
}

async function defaultBindings(): Promise<LocalLlamaBindings> {
  const native = await withNativeStdoutOnStderr(() => import("node-llama-cpp"));
  return {
    resolveModelFile: (model, options) =>
      withNativeStdoutOnStderr(() => native.resolveModelFile(model, options)),
    async getLlama(options) {
      const llama = await withNativeStdoutOnStderr(() =>
        native.getLlama({ gpu: options.gpu }),
      );
      return wrapLlama(llama);
    },
  };
}
type NodeLlama = Awaited<ReturnType<(typeof import("node-llama-cpp"))["getLlama"]>>;

function wrapLlama(llama: NodeLlama): NativeLlama {
  return {
    get gpu() {
      return llama.gpu === false ? false : String(llama.gpu);
    },
    async loadModel({ modelPath }) {
      const model = await llama.loadModel({ modelPath });
      return {
        async createEmbeddingContext() {
          const context = await model.createEmbeddingContext();
          return {
            async getEmbeddingFor(text) {
              const embedding = await context.getEmbeddingFor(text);
              return { vector: Array.from(embedding.vector) };
            },
            async dispose() {
              await context.dispose();
            },
          };
        },
        async dispose() {
          await model.dispose();
        },
      };
    },
    async dispose() {
      await llama.dispose();
    },
  };
}
export class LocalEmbeddingRuntime {
  readonly config: LocalEmbeddingConfig;
  readonly idleMs: number;
  private readonly injectedNative?: LocalLlamaBindings;
  private bindingsPromise: Promise<LocalLlamaBindings> | null = null;
  private preparePromise: Promise<void> | null = null;
  private llama: NativeLlama | null = null;
  private model: NativeModel | null = null;
  private context: NativeEmbeddingContext | null = null;
  private contextPromise: Promise<NativeEmbeddingContext> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private fingerprintValue: EmbeddingFingerprint | null = null;
  private currentStatus: EmbeddingRuntimeStatus;

  constructor(options: RuntimeOptions = {}) {
    this.config = options.config ?? resolveLocalEmbeddingConfig();
    this.injectedNative = options.native;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.currentStatus = {
      state: "preparing",
      model: this.config.modelUri,
      cacheDir: this.config.cacheDir,
    };
  }

  status(): EmbeddingRuntimeStatus {
    return this.currentStatus;
  }

  private bindings(): Promise<LocalLlamaBindings> {
    if (this.injectedNative) return Promise.resolve(this.injectedNative);
    this.bindingsPromise ??= defaultBindings();
    return this.bindingsPromise;
  }
  async prepare(): Promise<void> {
    if (this.fingerprintValue && this.model && this.llama) return;
    if (this.preparePromise) return this.preparePromise;

    this.currentStatus = {
      state: "preparing",
      model: this.config.modelUri,
      cacheDir: this.config.cacheDir,
    };
    this.preparePromise = this.prepareInner();
    try {
      await this.preparePromise;
    } catch (error) {
      this.currentStatus = {
        state: "degraded",
        model: this.config.modelUri,
        cacheDir: this.config.cacheDir,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      this.preparePromise = null;
    }
  }

  private async prepareInner(): Promise<void> {
    mkdirSync(this.config.cacheDir, { recursive: true });
    const native = await this.bindings();
    const modelPath = await this.resolveValidatedModel(native);
    this.llama = await this.initializeLlama(native);
    this.model = await this.llama.loadModel({ modelPath });

    const context = await this.ensureContext();
    const probe = await context.getEmbeddingFor(
      formatEmbeddingText("engram embedding probe", "document"),
    );
    const dimensions = Array.from(probe.vector).length;
    if (dimensions < 1) throw new Error("embedding model returned an empty vector");
    const fileSha256 = await sha256File(modelPath);
    const fingerprintBase = {
      modelUri: this.config.modelUri,
      modelPath,
      fileSha256,
      dimensions,
      inputFormatVersion: EMBEDDING_INPUT_FORMAT_VERSION,
    };
    const id = createHash("sha256")
      .update(JSON.stringify(fingerprintBase))
      .digest("hex");
    this.fingerprintValue = { id, ...fingerprintBase };

    this.currentStatus = {
      state: "ready",
      model: this.config.modelUri,
      cacheDir: this.config.cacheDir,
      modelPath,
      backend: this.llama.gpu === false ? "cpu" : String(this.llama.gpu),
      dimensions,
      fingerprint: id,
    };
    this.touchContext();
  }

  private async resolveValidatedModel(native: LocalLlamaBindings): Promise<string> {
    let modelPath = await native.resolveModelFile(this.config.modelUri, {
      directory: this.config.cacheDir,
      cli: false,
    });
    let inspection = inspectGgufFile(modelPath);
    if (inspection.valid) return modelPath;
    if (inspection.kind === "unreadable") {
      throw new Error(`model file is unreadable: ${inspection.details}`);
    }
    if (inspection.kind === "html" || inspection.kind === "invalid") {
      try {
        unlinkSync(modelPath);
      } catch (error) {
        throw new Error(
          `invalid model file could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      modelPath = await native.resolveModelFile(this.config.modelUri, {
        directory: this.config.cacheDir,
        cli: false,
      });
      inspection = inspectGgufFile(modelPath);
      if (inspection.valid) return modelPath;
    }
    throw new Error(`model file is not valid GGUF: ${inspection.details}`);
  }

  private async initializeLlama(native: LocalLlamaBindings): Promise<NativeLlama> {
    try {
      return await native.getLlama({ gpu: this.config.gpu });
    } catch (error) {
      if (this.config.gpu === false) throw error;
      process.stderr.write(
        `[engram-local] llama GPU initialization failed; retrying on CPU: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return native.getLlama({ gpu: false });
    }
  }
  private async ensureContext(): Promise<NativeEmbeddingContext> {
    if (this.context) return this.context;
    if (this.contextPromise) return this.contextPromise;
    if (!this.model) throw new Error("embedding model is not loaded");

    this.contextPromise = this.model.createEmbeddingContext();
    try {
      this.context = await this.contextPromise;
      return this.context;
    } finally {
      this.contextPromise = null;
    }
  }

  private touchContext(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      void this.disposeContext();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async disposeContext(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const context = this.context;
    this.context = null;
    if (context) await context.dispose();
  }
  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.prepare();
    const context = await this.ensureContext();
    const vectors: number[][] = [];
    for (const text of texts) {
      const embedding = await context.getEmbeddingFor(formatEmbeddingText(text, purpose));
      const vector = Array.from(embedding.vector);
      if (this.fingerprintValue && vector.length !== this.fingerprintValue.dimensions) {
        throw new Error(
          `embedding dimension changed from ${this.fingerprintValue.dimensions} to ${vector.length}`,
        );
      }
      vectors.push(vector);
    }
    this.touchContext();
    return vectors;
  }

  async fingerprint(): Promise<EmbeddingFingerprint> {
    await this.prepare();
    if (!this.fingerprintValue) throw new Error("embedding fingerprint is unavailable");
    return this.fingerprintValue;
  }

  async dispose(): Promise<void> {
    await this.disposeContext();
    const model = this.model;
    const llama = this.llama;
    this.model = null;
    this.llama = null;
    this.fingerprintValue = null;
    if (model) await model.dispose();
    if (llama) await llama.dispose();
  }
}
