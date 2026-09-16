import { describe, expect, test, vi } from "vitest";
import { generateEmbedding, generateEmbeddings } from "../services/embedding.js";

describe("embedding service", () => {
  test("uses purpose-aware local adapters when available", async () => {
    const embed = vi.fn(async (texts: string[], purpose: "query" | "document") =>
      texts.map((text) => [text.length, purpose === "query" ? 1 : 0]),
    );
    const ai = { embed } as unknown as Ai;

    await expect(generateEmbeddings(ai, ["document"])).resolves.toEqual([[8, 0]]);
    await expect(generateEmbedding(ai, "query")).resolves.toEqual([5, 1]);
    expect(embed).toHaveBeenNthCalledWith(1, ["document"], "document");
    expect(embed).toHaveBeenNthCalledWith(2, ["query"], "query");
  });

  test("keeps hosted Workers AI on the existing run contract", async () => {
    const run = vi.fn(async () => ({ data: [[1, 2, 3]] }));
    const ai = { run } as unknown as Ai;

    await expect(generateEmbeddings(ai, ["hosted"])).resolves.toEqual([[1, 2, 3]]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
