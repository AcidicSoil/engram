import { EMBEDDING_MODEL } from "@getengram/shared";
import type { Env } from "../types.js";

export type EmbeddingPurpose = "query" | "document";

type PurposeAwareEmbeddingAi = {
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
};

function isPurposeAwareEmbeddingAi(value: unknown): value is PurposeAwareEmbeddingAi {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { embed?: unknown };
  return typeof candidate.embed === "function";
}

export async function generateEmbeddings(
  ai: Env["AI"],
  texts: string[],
  purpose: EmbeddingPurpose = "document",
): Promise<number[][]> {
  if (isPurposeAwareEmbeddingAi(ai)) {
    return ai.embed(texts, purpose);
  }

  const response = await ai.run(EMBEDDING_MODEL as keyof AiModels, {
    text: texts,
  }) as { data: number[][] };
  return response.data;
}

export async function generateEmbedding(
  ai: Env["AI"],
  text: string,
): Promise<number[]> {
  const results = await generateEmbeddings(ai, [text], "query");
  return results[0];
}
