import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AbptLocalClient, normalizeLocalAbptUrl } from "./abpt-tools.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureServer() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("ABPT local MCP adapter", () => {
  it("rejects non-loopback API endpoints", () => {
    expect(() => normalizeLocalAbptUrl("https://example.com")).toThrow(/only permits loopback/u);
    expect(normalizeLocalAbptUrl("http://localhost:4318/path?q=x").href).toBe("http://localhost:4318/");
  });

  it("surfaces local API failures without leaking transport shapes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "archive warming" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");

    const client = new AbptLocalClient(`http://127.0.0.1:${address.port}`);
    await expect(client.status()).rejects.toThrow("Local ABPT API 503 for /api/workspace/status: archive warming");
  });

  it("routes reads to the canonical ABPT workspace API and forces search mode=local", async () => {
    const fixture = await fixtureServer();
    const client = new AbptLocalClient(fixture.baseUrl);

    await client.listProjects();
    await client.listConversations(undefined, { limit: 7, offset: 2 });
    await client.listConversations("project / id", { limit: 5, offset: 1 });
    await client.getConversation("conv / id");
    await client.getEvidence({ projectId: "p1", conversationId: "c1" });
    await client.searchLocal({ query: "needle", projectIds: ["p1"], limit: 8 });
    await client.grep({ pattern: "needle", conversationIds: ["c1"], output: "count", limit: 9 });
    await client.status();
    await client.syncStatus();

    expect(fixture.requests).toEqual([
      "/api/workspace/projects",
      "/api/workspace/conversations?limit=7&offset=2",
      "/api/workspace/projects/project%20%2F%20id/conversations?limit=5&offset=1",
      "/api/workspace/conversations/conv%20%2F%20id",
      "/api/workspace/evidence?projectId=p1&conversationId=c1",
      "/api/workspace/search?query=needle&projectIds=p1&mode=local&limit=8",
      "/api/workspace/grep?pattern=needle&match=literal&conversationIds=c1&output=count&limit=9",
      "/api/workspace/status",
      "/api/workspace/sync/status",
    ]);
  });
});
