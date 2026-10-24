/**
 * The /api/models call site (spec §Call sites): a COLD process where
 * nothing has warmed piModels() before the route runs — so the response
 * can only carry 9Router models if GET awaits ensureNineRouterCatalog().
 * The inherited key is stripped first: a developer shell exporting
 * NINEROUTER_API_KEY would otherwise make the keyless case discover.
 * Network-free: global fetch is stubbed, never a real router.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

delete process.env.NINEROUTER_API_KEY;

const { GET } = await import("../app/api/models/route.ts");

const originalFetch = globalThis.fetch;
let fetches = 0;

before(() => {
	globalThis.fetch = (async () => {
		fetches++;
		return new Response(
			JSON.stringify({
				object: "list",
				data: [
					{
						id: "cc/claude-opus-4-6",
						object: "model",
						owned_by: "cc",
						context_length: 1_000_000,
						max_completion_tokens: 128_000,
						capabilities: { vision: true, reasoning: true, tools: true },
					},
					{ id: "m/tool-less", capabilities: { tools: false } },
				],
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
});

after(() => {
	globalThis.fetch = originalFetch;
	delete process.env.NINEROUTER_API_KEY;
});

describe("GET /api/models — the ensure call site on a cold catalog", () => {
	it("keyless → no discovery request, no 9Router models", async () => {
		const body = await (await GET()).json();
		assert.equal(fetches, 0, "no key → the scheduler returns before any request");
		assert.equal(body.models.some((m: { provider: string }) => m.provider === "9router"), false);
	});

	it("keyed → the route awaits discovery and the models federate", async () => {
		process.env.NINEROUTER_API_KEY = "test-key-9router-000";
		const body = await (await GET()).json();
		assert.equal(fetches, 1, "cold catalog → exactly one discovery fetch, awaited by the route");

		const found = body.models.find(
			(m: { provider: string; id: string }) => m.provider === "9router" && m.id === "cc/claude-opus-4-6",
		);
		assert.ok(found, "mapped into the picker payload");
		assert.equal(found.contextWindow, 1_000_000);
		assert.equal(found.maxTokens, 128_000);
		assert.deepEqual(found.supportedLevels, ["off", "low", "medium", "high"]);
		assert.deepEqual(found.input, ["text", "image"]);
		assert.equal(found.cost.input, 0, "owner decision: $0 everywhere");
		assert.equal(
			body.models.some((m: { id: string }) => m.id === "m/tool-less"),
			false,
			"tool-less models are omitted",
		);

		const provider = body.providers.find((p: { id: string }) => p.id === "9router");
		assert.deepEqual(provider, { id: "9router", envVar: "NINEROUTER_API_KEY", keyPresent: true });
	});

	it("warm within the TTL → no second discovery fetch", async () => {
		await (await GET()).json();
		assert.equal(fetches, 1, "30 s TTL suppresses the refetch");
	});
});
