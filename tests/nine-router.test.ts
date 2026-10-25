/**
 * The 9Router provider (spec 2026-10-24): pure entry mapping, the dynamic
 * provider's discovery contract, and the cross-layer metadata pin between
 * src/agent/nine-router.ts and src/core/auth-keys.ts's CUSTOM_PROVIDER_KEYS
 * (core may not import the agent layer, so this test is the drift gate).
 * Network-free throughout: a stubbed fetch, never a real router.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import {
	createNineRouterProvider,
	mapNineRouterModel,
	NINE_ROUTER_API_KEY_ENV,
	NINE_ROUTER_BASE_URL,
	NINE_ROUTER_DISPLAY_NAME,
	NINE_ROUTER_PROVIDER_ID,
} from "../src/agent/nine-router.ts";
import { piModels } from "../src/agent/models.ts";
import { CUSTOM_PROVIDER_KEYS } from "../src/core/auth-keys.ts";
import { ensureNineRouterCatalog, modelCatalog } from "../src/server/model-catalog.ts";

// Throwaway value — env resolution is part of what's under test.
const TEST_KEY = "test-key-9router-000";
const originalKey = process.env[NINE_ROUTER_API_KEY_ENV];
before(() => {
	process.env[NINE_ROUTER_API_KEY_ENV] = TEST_KEY;
});
after(() => {
	if (originalKey === undefined) delete process.env[NINE_ROUTER_API_KEY_ENV];
	else process.env[NINE_ROUTER_API_KEY_ENV] = originalKey;
});

/** One realistic /v1/models row: 9Router publishes limits BOTH top-level
 *  (snake_case) and inside capabilities (camelCase). */
const CAPABLE_ROW = {
	id: "cc/claude-opus-4-6",
	object: "model",
	owned_by: "cc",
	context_length: 1_000_000,
	max_completion_tokens: 128_000,
	capabilities: { vision: true, reasoning: true, tools: true, contextWindow: 1_000_000, maxOutput: 128_000 },
};

describe("mapNineRouterModel — the pure entry mapper", () => {
	it("maps limits, capabilities, and the id as the display name", () => {
		const model = mapNineRouterModel(CAPABLE_ROW);
		assert.ok(model);
		assert.equal(model.id, "cc/claude-opus-4-6");
		assert.equal(model.name, "cc/claude-opus-4-6", "owner decision: name IS the id");
		assert.equal(model.provider, "9router");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, "http://localhost:20128/v1");
		assert.equal(model.contextWindow, 1_000_000, "top-level context_length wins");
		assert.equal(model.maxTokens, 128_000, "top-level max_completion_tokens wins");
		assert.deepEqual(model.input, ["text", "image"], "vision capability adds image input");
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("falls back to capabilities limits, then to the 200k/32k defaults", () => {
		const capsOnly = mapNineRouterModel({
			id: "m/only-caps",
			capabilities: { contextWindow: 128_000, maxOutput: 8_000, tools: true },
		});
		assert.equal(capsOnly!.contextWindow, 128_000);
		assert.equal(capsOnly!.maxTokens, 8_000);

		const bare = mapNineRouterModel({ id: "m/bare" });
		assert.equal(bare!.contextWindow, 200_000, "owner fallback: 200k");
		assert.equal(bare!.maxTokens, 32_000, "owner fallback: 32k");

		const junk = mapNineRouterModel({ id: "m/junk", context_length: -5, max_completion_tokens: "many" });
		assert.equal(junk!.contextWindow, 200_000, "non-positive/NaN limits never win");
		assert.equal(junk!.maxTokens, 32_000);
	});

	it("reasoning maps to off/low/medium/high; flat models map to off only", () => {
		const reasoning = mapNineRouterModel(CAPABLE_ROW)!;
		assert.deepEqual(reasoning.thinkingLevelMap, { minimal: null, xhigh: null, max: null });

		const flat = mapNineRouterModel({ id: "m/flat", capabilities: { tools: true } })!;
		assert.equal(flat.reasoning, false);
		assert.equal(flat.thinkingLevelMap, undefined);
		assert.deepEqual(flat.input, ["text"], "no vision → text only");
	});

	it("drops tool-less rows and invalid rows, keeping combos and odd ids", () => {
		assert.equal(mapNineRouterModel({ id: "m/no-tools", capabilities: { tools: false } }), null);
		assert.equal(mapNineRouterModel({ id: "" }), null);
		assert.equal(mapNineRouterModel({}), null);
		assert.equal(mapNineRouterModel({ id: 42 }), null);
		assert.equal(mapNineRouterModel("nope"), null);
		assert.equal(mapNineRouterModel(null), null);
		// Combos are plain names (no slash) — they are regular models.
		assert.equal(mapNineRouterModel({ id: "my-combo", capabilities: { tools: true } })!.id, "my-combo");
	});
});

describe("createNineRouterProvider — discovery over /v1/models", () => {
	it("calls {baseUrl}/models with the bearer header and publishes the mapped list", async () => {
		const requests: Request[] = [];
		const provider = createNineRouterProvider(async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(JSON.stringify({ object: "list", data: [CAPABLE_ROW, { id: "m/no-tools", capabilities: { tools: false } }] }), { status: 200 });
		});
		const models = createModels();
		models.setProvider(provider);

		const result = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.equal(result.errors.size, 0, JSON.stringify([...result.errors]));

		const first = requests[0];
		assert.ok(first, "exactly one discovery request was made");
		assert.equal(first.url, "http://localhost:20128/v1/models");
		assert.equal(first.headers.get("authorization"), `Bearer ${TEST_KEY}`, "resolved key rides as bearer");
		assert.equal(first.headers.get("accept"), "application/json");

		const list = provider.getModels();
		assert.equal(list.length, 1, "tool-less row dropped, capable row kept");
		assert.equal(list[0]!.id, "cc/claude-opus-4-6");
	});

	it("a failed refresh keeps the previous list and reports the error", async () => {
		let mode: "ok" | "down" = "ok";
		const provider = createNineRouterProvider(async () => {
			if (mode === "down") throw new Error("9router down");
			return new Response(JSON.stringify({ object: "list", data: [CAPABLE_ROW] }), { status: 200 });
		});
		const models = createModels();
		models.setProvider(provider);

		await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.equal(provider.getModels().length, 1, "warm list");

		mode = "down";
		const failed = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.ok(failed.errors.size >= 1, "the failure is reported, not thrown");
		assert.equal(provider.getModels().length, 1, "previous list retained (spec failure table)");
	});

	it("a non-2xx reply is reported as a 9router error and publishes nothing", async () => {
		const provider = createNineRouterProvider(async () => Response.json({}, { status: 401 }));
		const models = createModels();
		models.setProvider(provider);

		// pi-ai reports provider failures in the result, never throws
		// (models.d.ts: "Provider errors ... are returned without rejecting").
		const result = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.equal(result.errors.size, 1, JSON.stringify([...result.errors]));
		const error = result.errors.get(NINE_ROUTER_PROVIDER_ID);
		assert.ok(error?.message.includes("401"), `unexpected error: ${error?.message}`);
		assert.deepEqual(provider.getModels(), [], "a rejected list publishes nothing");
	});

	it("a bare-array body (no data wrapper) is accepted", async () => {
		const provider = createNineRouterProvider(
			async () => new Response(JSON.stringify([CAPABLE_ROW]), { status: 200 }),
		);
		const models = createModels();
		models.setProvider(provider);

		const result = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.equal(result.errors.size, 0, JSON.stringify([...result.errors]));
		const list = provider.getModels();
		assert.equal(list.length, 1, "the whole body is the row list");
		assert.equal(list[0]!.id, "cc/claude-opus-4-6");
	});

	it("no key in the env → the provider is skipped, no request at all", async () => {
		delete process.env[NINE_ROUTER_API_KEY_ENV];
		let calls = 0;
		const provider = createNineRouterProvider(async () => {
			calls++;
			return new Response(JSON.stringify({ data: [CAPABLE_ROW] }), { status: 200 });
		});
		const models = createModels();
		models.setProvider(provider);

		const result = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.equal(calls, 0, "unconfigured providers are skipped before fetchModels");
		assert.equal(result.errors.size, 0, JSON.stringify([...result.errors]));
		assert.deepEqual(provider.getModels(), []);
		// Restore the file-level before() value for the later cases in this file.
		process.env[NINE_ROUTER_API_KEY_ENV] = TEST_KEY;
	});

	it("a JSON null body → empty list, reported error-free, no throw", async () => {
		const provider = createNineRouterProvider(
			async () => new Response(JSON.stringify(null), { status: 200 }),
		);
		const models = createModels();
		models.setProvider(provider);

		const result = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
		assert.equal(
			result.errors.size,
			0,
			`null is valid JSON, not a failure: ${JSON.stringify([...result.errors])}`,
		);
		assert.deepEqual(provider.getModels(), []);
	});

	it("discovery carries an abort signal bound to the 5 s budget", async () => {
		const signals: Array<AbortSignal | null | undefined> = [];
		// Capture the deadline honestly: the composed signal exposes no
		// readable timeout, but AbortSignal.timeout is called at fetch time,
		// so record its argument (delegating to the real one) and restore.
		const realTimeout = AbortSignal.timeout;
		const timeoutBounds: number[] = [];
		AbortSignal.timeout = ((ms: number) => {
			timeoutBounds.push(ms);
			return realTimeout.call(AbortSignal, ms);
		}) as typeof AbortSignal.timeout;
		try {
			const provider = createNineRouterProvider(async (_input, init) => {
				signals.push(init?.signal);
				return new Response(JSON.stringify({ data: [CAPABLE_ROW] }), { status: 200 });
			});
			const models = createModels();
			models.setProvider(provider);

			const result = await models.refresh({ providers: [NINE_ROUTER_PROVIDER_ID], force: true });
			assert.equal(result.errors.size, 0, JSON.stringify([...result.errors]));
		} finally {
			AbortSignal.timeout = realTimeout;
		}
		const signal = signals[0];
		assert.ok(signal instanceof AbortSignal, "fetchModels composes an AbortSignal into init.signal");
		assert.equal(signal.aborted, false, "fresh list call, nothing pre-aborted");
		assert.deepEqual(timeoutBounds, [5000], "spec: one model-list call gets 5000 ms");
	});
});

describe("registration", () => {
	it("piModels() serves the 9Router provider beside the builtins", () => {
		const provider = piModels().getProvider(NINE_ROUTER_PROVIDER_ID);
		assert.ok(provider, "registered in the process-wide collection");
		assert.equal(provider.name, NINE_ROUTER_DISPLAY_NAME);
		assert.equal(provider.baseUrl, NINE_ROUTER_BASE_URL);
		assert.ok(piModels().getProviders().length > 30, "builtins registered too");
		// Empty before the first refresh — a dynamic provider's contract.
		assert.deepEqual(piModels().getModels(NINE_ROUTER_PROVIDER_ID), []);
	});

	it("core's CUSTOM_PROVIDER_KEYS row matches the agent constants (cross-layer pin)", () => {
		const row = CUSTOM_PROVIDER_KEYS.find((p) => p.id === NINE_ROUTER_PROVIDER_ID);
		assert.deepEqual(row, {
			id: NINE_ROUTER_PROVIDER_ID,
			envVar: NINE_ROUTER_API_KEY_ENV,
			label: NINE_ROUTER_DISPLAY_NAME,
		});
	});
});

describe("ensureNineRouterCatalog — the refresh scheduler (spec §Refresh lifecycle)", () => {
	const originalFetch = globalThis.fetch;
	const originalKey = process.env[NINE_ROUTER_API_KEY_ENV];
	let fetches = 0;
	const workingFetch = async () => {
		fetches++;
		return new Response(JSON.stringify({ object: "list", data: [CAPABLE_ROW] }), { status: 200 });
	};
	const downFetch = async () => {
		fetches++;
		throw new Error("ECONNREFUSED — 9router is not running");
	};
	after(() => {
		globalThis.fetch = originalFetch;
		if (originalKey === undefined) delete process.env[NINE_ROUTER_API_KEY_ENV];
		else process.env[NINE_ROUTER_API_KEY_ENV] = originalKey;
	});

	// ORDER MATTERS: node:test runs these in declaration order against ONE
	// module-local scheduler and ONE process-wide catalog, so each case
	// states what it relies on. Failure runs FIRST, while the catalog is
	// still empty — an empty catalog AWAITS its refresh, which is what makes
	// every assertion below synchronous and race-free.
	it("dead router → the call resolves, nothing federates, no throw", async () => {
		process.env[NINE_ROUTER_API_KEY_ENV] = TEST_KEY;
		globalThis.fetch = downFetch as unknown as typeof fetch;
		await assert.doesNotReject(() => ensureNineRouterCatalog(), "swallowed, never thrown (spec failure table)");
		assert.equal(fetches, 1, "cold catalog → the refresh was attempted and awaited");
		assert.equal(
			modelCatalog().models.some((m) => m.provider === "9router"),
			false,
			"no models survive a cold failure — the picker's absence is the honest signal",
		);
	});

	it("reachable router → one awaited fetch federates the mapped models", async () => {
		process.env[NINE_ROUTER_API_KEY_ENV] = TEST_KEY;
		globalThis.fetch = workingFetch as unknown as typeof fetch;
		// Still cold (the failure above left nothing), so `await run` applies;
		// ttlMs: 0 is the seam that forces a re-attempt past the failed attempt's TTL.
		await ensureNineRouterCatalog({ ttlMs: 0 });
		assert.equal(fetches, 2, "attempted again, awaited");
		const found = modelCatalog().models.find((m) => m.provider === "9router" && m.id === "cc/claude-opus-4-6");
		assert.ok(found, "mapped model reaches the picker projection");
		assert.equal(found.contextWindow, 1_000_000);
		assert.deepEqual(found.supportedLevels, ["off", "low", "medium", "high"]);
	});

	it("inside the 30 s TTL → no refetch", async () => {
		await ensureNineRouterCatalog();
		assert.equal(fetches, 2, "warm catalog inside the TTL returns without touching the network");
	});

	it("keyless → returns before any request", async () => {
		delete process.env[NINE_ROUTER_API_KEY_ENV];
		await ensureNineRouterCatalog({ ttlMs: 0 });
		assert.equal(fetches, 2, "no key → the scheduler never fetches");
		assert.equal(
			modelCatalog().models.some((m) => m.provider === "9router"),
			false,
			"keyless providers never federate into the picker",
		);
	});
});
