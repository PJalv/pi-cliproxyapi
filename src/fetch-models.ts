// Discovery:
//   1. GET <host>/.well-known/pi with User-Agent: pi-cliproxyapi/<ver>
//      → returns the server contract document (see PLAN.md).
//   2. On 404 / 5xx / non-JSON / network error → fall back to:
//      GET <endpoint>/v1/models with Authorization: Bearer <apiKey>
//      → classify locally via compat.ts.
//
// fetchDiscovery() returns a normalized in-memory model. Callers shouldn't
// know which path was used (except for logging).

import type { Api } from "@earendil-works/pi-ai";

import {
	classifyCustom,
	inputFromId,
	isExcluded,
	modelDefaults,
	parseUpstreamInput,
	normalizeSuggestedProvider,
	reasoningFromId,
} from "./compat.ts";
import { readFileSync } from "node:fs";

import { writeDiscoveryCache } from "./cache.ts";
import type { ProxyConfig } from "./config.ts";
import { resolveConfigValue } from "./config.ts";
import { CONTRACT_HEADER, PREFERRED_CONTRACT } from "./fetch-usage.ts";
import { log } from "./log.ts";

/** Extension version, read from the manifest so there is one source of truth. */
export const PLUGIN_VERSION: string = (() => {
	try {
		const manifest = new URL("../package.json", import.meta.url);
		return JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
})();

export const PLUGIN_USER_AGENT = `pi-cliproxyapi/${PLUGIN_VERSION}`;
// The forked CLIProxyAPI may build its model catalogue on demand. Five
// seconds is too short for a cold refresh and makes the UI report a timeout.
const REQUEST_TIMEOUT_MS = 30_000;

export interface DiscoveryModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	/** Canonical Pi level -> provider level, supplied by the live proxy config. */
	thinkingLevelMap?: Record<string, string>;
	contextWindow: number;
	maxTokens: number;
	/** Accepted input modalities; inferred when upstream omits them. */
	input?: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface DiscoveryBuiltinProvider {
	/** "openai" or "anthropic" — name of the Pi built-in provider. */
	name: string;
	api: Api;
	/** Models from upstream that map to this built-in provider. */
	models: DiscoveryModelEntry[];
}

export interface DiscoveryCustomEntry extends DiscoveryModelEntry {
	api: Api;
	/** Suggested custom provider slug (e.g. "myproxy-glm"). */
	suggestedProvider: string;
	/** Raw upstream owned_by, for diagnostics. */
	ownedBy: string;
}

export interface Discovery {
	source: "well-known" | "v1-models";
	upstreamVersion: string | null;
	builtinProviders: DiscoveryBuiltinProvider[];
	customPool: DiscoveryCustomEntry[];
	serverDiscoveryExcludes: string[];
	/** Total ids seen before any filtering. */
	upstreamTotal: number;
}

interface RawUpstreamModel {
	id: string;
	owned_by: string;
}

// --------------------------------------------------------------------------- HTTP

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("timeout")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Origin of the proxy endpoint, or null when it is not a usable URL. */
function endpointOrigin(endpoint: string): string | null {
	try {
		return new URL(endpoint).origin;
	} catch {
		return null;
	}
}

function discoveryUrl(endpoint: string): string | null {
	const origin = endpointOrigin(endpoint);
	return origin ? new URL("/.well-known/pi", origin).toString() : null;
}

/** Model catalogue served by the pi-bridge plugin inside CLIProxyAPI. */
const PLUGIN_DISCOVERY_PATH = "/v0/resource/plugins/pi-bridge/well-known";
/** Path used while the plugin was in testing; kept for older deployments. */
const PLUGIN_DISCOVERY_PATH_LEGACY =
	"/v0/resource/plugins/pi-bridge/dev/well-known";

// --------------------------------------------------------------------------- well-known path

/**
 * Fetch the model catalogue.
 *
 * The pi-bridge plugin is preferred: it authenticates with the API key already
 * configured for model calls and answers the newest contract. A deployment
 * still running the standalone sidecar has no such route, so the legacy
 * unauthenticated path remains as a fallback.
 */
async function tryWellKnown(cfg: ProxyConfig): Promise<Discovery | null> {
	const origin = endpointOrigin(cfg.proxy.endpoint);
	if (!origin) {
		log.warn(`proxy.endpoint is not a valid URL: ${cfg.proxy.endpoint}`);
		return null;
	}

	const apiKey = cfg.proxy.apiKey ? resolveConfigValue(cfg.proxy.apiKey) : "";
	if (apiKey) {
		const headers = {
			Authorization: `Bearer ${apiKey}`,
			[CONTRACT_HEADER]: String(PREFERRED_CONTRACT),
		};
		for (const path of [PLUGIN_DISCOVERY_PATH, PLUGIN_DISCOVERY_PATH_LEGACY]) {
			const discoveryURL = new URL(path, origin);
			// A Pi refresh must re-read CLIProxyAPI's live config, not merely the
			// bridge's previous capability document.
			discoveryURL.searchParams.set("refresh", "1");
			const viaPlugin = await tryDiscoverySource(
				cfg,
				discoveryURL.toString(),
				headers,
				"pi-bridge",
			);
			if (viaPlugin) return viaPlugin;
		}
	}

	const legacy = discoveryUrl(cfg.proxy.endpoint);
	return legacy ? tryDiscoverySource(cfg, legacy, {}, "well-known") : null;
}

async function tryDiscoverySource(
	cfg: ProxyConfig,
	url: string,
	extraHeaders: Record<string, string>,
	label: string,
): Promise<Discovery | null> {
	let resp: Response;
	try {
		resp = await fetchWithTimeout(url, {
			headers: {
				...extraHeaders,
				"User-Agent": PLUGIN_USER_AGENT,
				Accept: "application/json",
			},
		});
	} catch (err) {
		log.debug(`${label} fetch failed:`, (err as Error).message);
		return null;
	}
	if (!resp.ok) {
		log.debug(`${label} returned ${resp.status}`);
		return null;
	}
	let body: any;
	try {
		body = await resp.json();
	} catch {
		log.debug(`${label} returned non-JSON`);
		return null;
	}
	if (!body || body.schemaVersion !== 1) {
		log.debug(`${label} schemaVersion != 1`);
		return null;
	}

	const builtin: DiscoveryBuiltinProvider[] = [];
	const builtinProviders = (body.builtinProviders ?? {}) as Record<string, any>;
	for (const [name, p] of Object.entries(builtinProviders)) {
		if (!p || !Array.isArray(p.models)) continue;
		const models: DiscoveryModelEntry[] = p.models.map(
			(m: any): DiscoveryModelEntry => ({
				id: String(m.id),
				name: typeof m.name === "string" ? m.name : String(m.id),
				reasoning: Boolean(m.reasoning ?? reasoningFromId(String(m.id))),
				thinkingLevelMap:
					m.thinkingLevelMap && typeof m.thinkingLevelMap === "object"
						? m.thinkingLevelMap
						: undefined,
				contextWindow:
					typeof m.contextWindow === "number" ? m.contextWindow : 200_000,
				maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : 16_000,
				cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				input: parseUpstreamInput(m.input),
			}),
		);
		builtin.push({ name, api: (p.api as Api) ?? "openai-responses", models });
	}

	const customPool: DiscoveryCustomEntry[] = (
		Array.isArray(body.customModelPool) ? body.customModelPool : []
	).map(
		(m: any): DiscoveryCustomEntry => ({
			id: String(m.id),
			name: typeof m.name === "string" ? m.name : String(m.id),
			reasoning: Boolean(m.reasoning ?? reasoningFromId(String(m.id))),
			thinkingLevelMap:
				m.thinkingLevelMap && typeof m.thinkingLevelMap === "object"
					? m.thinkingLevelMap
					: undefined,
			contextWindow:
				typeof m.contextWindow === "number" ? m.contextWindow : 128_000,
			maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : 16_000,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			input: parseUpstreamInput(m.input),
			api: (m.api as Api) ?? "openai-completions",
			suggestedProvider: normalizeSuggestedProvider(
				typeof m.suggestedProviderName === "string"
					? m.suggestedProviderName
					: "misc",
				cfg.proxy.providerPrefix,
			),
			ownedBy: typeof m.owned_by === "string" ? m.owned_by : "",
		}),
	);

	return {
		source: "well-known",
		// The sidecar only ever filled lproxy.upstreamVersion, and with null at
		// that; the bridge reports the real proxy version under upstream.
		upstreamVersion:
			typeof body?.upstream?.upstreamVersion === "string"
				? body.upstream.upstreamVersion
				: typeof body?.lproxy?.upstreamVersion === "string"
					? body.lproxy.upstreamVersion
					: null,
		builtinProviders: builtin,
		customPool,
		serverDiscoveryExcludes: Array.isArray(body.discoveryExcludes)
			? body.discoveryExcludes.filter(
					(s: unknown): s is string => typeof s === "string",
				)
			: [],
		upstreamTotal:
			typeof body?.counts?.upstreamTotal === "number"
				? body.counts.upstreamTotal
				: 0,
	};
}

// --------------------------------------------------------------------------- /v1/models path

async function fetchRawModels(
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<RawUpstreamModel[]> {
	const origin = endpointOrigin(cfg.proxy.endpoint);
	if (!origin) {
		throw new Error(`proxy.endpoint is not a valid URL: ${cfg.proxy.endpoint}`);
	}
	const url = new URL("/v1/models", origin).toString();
	const resp = await fetchWithTimeout(url, {
		headers: {
			Authorization: `Bearer ${resolvedKey}`,
			Accept: "application/json",
			"User-Agent": PLUGIN_USER_AGENT,
		},
	});
	if (!resp.ok) {
		throw new Error(`/v1/models returned ${resp.status}`);
	}
	const body = (await resp.json()) as {
		data?: Array<{ id?: unknown; owned_by?: unknown }>;
	};
	if (!body?.data || !Array.isArray(body.data)) return [];
	return body.data
		.map((m) => ({
			id: typeof m.id === "string" ? m.id : "",
			owned_by: typeof m.owned_by === "string" ? m.owned_by : "",
		}))
		.filter((m) => m.id);
}

function classifyLocally(raw: RawUpstreamModel[], cfg: ProxyConfig): Discovery {
	const excludes = cfg.discoveryExcludes;
	const builtinByName = new Map<string, DiscoveryBuiltinProvider>();
	const customPool: DiscoveryCustomEntry[] = [];
	let upstreamTotal = 0;

	for (const m of raw) {
		upstreamTotal++;
		if (isExcluded(m.id, excludes)) continue;

		if (m.owned_by === "openai") {
			const entry = modelDefaults(m.id);
			pushBuiltin(
				builtinByName,
				"openai",
				"openai-responses",
				entryToDiscovery(entry),
			);
			continue;
		}
		if (m.owned_by === "anthropic") {
			const entry = modelDefaults(m.id);
			pushBuiltin(
				builtinByName,
				"anthropic",
				"anthropic-messages",
				entryToDiscovery(entry),
			);
			continue;
		}
		const { slug, api } = classifyCustom(m.owned_by, cfg.proxy.providerPrefix);
		const base = modelDefaults(m.id);
		customPool.push({
			id: m.id,
			name: base.name ?? m.id,
			reasoning: base.reasoning ?? false,
			contextWindow: base.contextWindow ?? 128_000,
			maxTokens: base.maxTokens ?? 16_000,
			input: base.input,
			cost: base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			api,
			suggestedProvider: slug,
			ownedBy: m.owned_by,
		});
	}

	return {
		source: "v1-models",
		upstreamVersion: null,
		builtinProviders: Array.from(builtinByName.values()),
		customPool,
		serverDiscoveryExcludes: [],
		upstreamTotal,
	};
}

function pushBuiltin(
	map: Map<string, DiscoveryBuiltinProvider>,
	name: string,
	api: Api,
	entry: DiscoveryModelEntry,
): void {
	let p = map.get(name);
	if (!p) {
		p = { name, api, models: [] };
		map.set(name, p);
	}
	p.models.push(entry);
}

function entryToDiscovery(
	base: ReturnType<typeof modelDefaults>,
): DiscoveryModelEntry {
	return {
		id: base.id,
		name: base.name ?? base.id,
		reasoning: base.reasoning ?? false,
		contextWindow: base.contextWindow ?? 128_000,
		maxTokens: base.maxTokens ?? 16_000,
		input: base.input ?? inputFromId(base.id),
		cost: base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// --------------------------------------------------------------------------- public

export async function fetchDiscovery(
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<Discovery> {
	const wk = await tryWellKnown(cfg);
	if (wk) {
		log.info(
			`discovery via /.well-known/pi: ${wk.builtinProviders.length} builtin, ${wk.customPool.length} custom`,
		);
		writeDiscoveryCache(wk);
		return wk;
	}
	if (!resolvedKey) {
		throw new Error(
			"well-known unavailable AND proxy apiKey is empty — cannot fall back to /v1/models. Set proxy.apiKey in config.",
		);
	}
	const raw = await fetchRawModels(cfg, resolvedKey);
	const d = classifyLocally(raw, cfg);
	log.info(
		`discovery via /v1/models: ${d.builtinProviders.length} builtin, ${d.customPool.length} custom`,
	);
	writeDiscoveryCache(d);
	return d;
}

/** Convenience: flat set of all upstream ids (after server-applied excludes). */
export function discoveryToIdSet(d: Discovery): Set<string> {
	const out = new Set<string>();
	for (const p of d.builtinProviders) for (const m of p.models) out.add(m.id);
	for (const m of d.customPool) out.add(m.id);
	return out;
}
