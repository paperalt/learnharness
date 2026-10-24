/**
 * The 9Router custom provider (spec docs/superpowers/specs/
 * 2026-10-24-9router-provider-design.md): decolua/9router's local
 * OpenAI-compatible router at http://localhost:20128/v1 as one entry in
 * pi-ai's provider set. It is a DYNAMIC provider: `models: []` plus
 * `fetchModels` reading live `GET /v1/models` — the router owns the model
 * list (upstreams come and go), so LearnHarness never caches it to disk.
 *
 * Pure parts (the mapper, the constants) live here so tests can pin the
 * mapping with no network. This is the agent layer: it may import core,
 * and it already owns provider construction (src/agent/models.ts).
 */
import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const NINE_ROUTER_PROVIDER_ID = "9router";
export const NINE_ROUTER_DISPLAY_NAME = "9Router";
export const NINE_ROUTER_API_KEY_ENV = "NINEROUTER_API_KEY";
export const NINE_ROUTER_BASE_URL = "http://localhost:20128/v1";

/** Owner decisions (spec Decisions table): no price data upstream → $0;
 *  a row without limits falls back to 200k context / 32k output. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;
/** Per-request budget for one model-list call (spec: "Request exceeds 5 s → aborted"). */
const FETCH_TIMEOUT_MS = 5_000;

/** The 9Router capabilities block (camelCase) — every field optional. */
interface NineRouterCapabilities {
	vision?: unknown;
	reasoning?: unknown;
	tools?: unknown;
	contextWindow?: unknown;
	maxOutput?: unknown;
}

/** One `GET /v1/models` entry. 9Router publishes limits top-level in
 *  snake_case AND nested in capabilities; both are read. */
interface NineRouterModelEntry {
	id?: unknown;
	context_length?: unknown;
	max_completion_tokens?: unknown;
	capabilities?: unknown;
}

/** First finite, positive candidate — otherwise undefined (the caller
 *  applies the owner's default). */
function positiveNumber(...candidates: unknown[]): number | undefined {
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function asCapabilities(raw: unknown): NineRouterCapabilities | null {
	return typeof raw === "object" && raw !== null ? (raw as NineRouterCapabilities) : null;
}

/**
 * One `/v1/models` entry → a pi chat model, or `null` to skip the row
 * (invalid id, or `capabilities.tools === false` — this app's agents are
 * tool-calling agents, so a tool-less model is unusable, not merely
 * limited). Never throws on a single bad row.
 */
export function mapNineRouterModel(entry: unknown): Model<"openai-completions"> | null {
	if (typeof entry !== "object" || entry === null) return null;
	const row = entry as NineRouterModelEntry;
	if (typeof row.id !== "string" || row.id.length === 0) return null;
	const caps = asCapabilities(row.capabilities);
	if (caps?.tools === false) return null;
	const reasoning = caps?.reasoning === true;

	const model: Model<"openai-completions"> = {
		id: row.id,
		// Owner decision: the display name IS the model id (upstream `name`
		// is ignored — ids like `cc/claude-opus-4-6` are the recognizable form).
		name: row.id,
		api: "openai-completions",
		provider: NINE_ROUTER_PROVIDER_ID,
		baseUrl: NINE_ROUTER_BASE_URL,
		reasoning,
		input: caps?.vision === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveNumber(row.context_length, caps?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveNumber(row.max_completion_tokens, caps?.maxOutput) ?? DEFAULT_MAX_TOKENS,
	};
	if (reasoning) {
		// Owner decision: expose off/low/medium/high only. 9Router translates
		// `reasoning_effort` per upstream, so pi's standard levels are the
		// honest set; minimal/xhigh/max are marked unsupported.
		model.thinkingLevelMap = { minimal: null, xhigh: null, max: null };
	}
	return model;
}

/**
 * The provider factory. `fetchImpl` defaults to a LATE-bound global fetch
 * so tests can stub `globalThis.fetch` after this module has loaded.
 */
export function createNineRouterProvider(
	fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Provider<"openai-completions"> {
	return createProvider({
		id: NINE_ROUTER_PROVIDER_ID,
		name: NINE_ROUTER_DISPLAY_NAME,
		baseUrl: NINE_ROUTER_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("9Router API key", [NINE_ROUTER_API_KEY_ENV]),
		},
		models: [],
		fetchModels: async (context) => {
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const baseUrl = (context.baseUrl ?? NINE_ROUTER_BASE_URL).replace(/\/+$/, "");
			const response = await fetchImpl(`${baseUrl}/models`, {
				headers: {
					accept: "application/json",
					...(key ? { authorization: `Bearer ${key}` } : {}),
				},
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
			});
			if (!response.ok) throw new Error(`9Router model list failed: ${response.status}`);
			const body = (await response.json()) as { data?: unknown } | unknown[];
			const rows = Array.isArray(body) ? body : (body.data ?? []);
			if (!Array.isArray(rows)) return [];
			return rows
				.map(mapNineRouterModel)
				.filter((model): model is Model<"openai-completions"> => model !== null);
		},
		api: openAICompletionsApi(),
	});
}
