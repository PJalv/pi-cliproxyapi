// Local fallback heuristics + helpers for when /.well-known/pi is not available.
// When /.well-known/pi succeeds, we trust the server. This module is the
// secondary classifier (/v1/models path) and a couple of small utilities.

import type { Api } from "@earendil-works/pi-ai";

import type { CustomProviderModelConfig } from "./config.ts";

/** API families we know how to route through CliProxyAPI. */
export const ALLOWED_APIS: ReadonlySet<Api> = new Set<Api>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
]);

/**
 * For openai-* APIs the proxy endpoint is "https://.../v1" — pass it through.
 * For anthropic-messages the SDK expects the host root, so strip the trailing /v1.
 */
export function baseUrlFor(api: Api, endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		return trimmed.replace(/\/v1$/, "");
	}
	return trimmed;
}

/** Match the well-known glob-ish excludes (server-defined patterns like "*:*"). */
export function isExcluded(id: string, patterns: string[]): boolean {
	if (!id) return true;
	for (const pat of patterns) {
		const rx = new RegExp(
			"^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
		);
		if (rx.test(id)) return true;
	}
	return false;
}

/** Defaults used when the catalog has nothing on a model id. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const REASONING_RX: RegExp[] = [
	/.*-thinking$/,
	/^gpt-5(\.\d+)?(-.*)?$/,
	/^gemini-3(\.\d+)?(-.*)?$/,
];
const VISION_RX: RegExp[] = [
	/-vision$/,
	/-omni$/,
	/-image.*$/,
	/-multimodal.*$/,
	/^o1(-.*)?$/,
	/^gpt-4o(-.*)?$/,
];

/**
 * Infer accepted input modalities from a model id when the server doesn't say.
 * "vision"/"omni"/"image"/"multimodal" are reliable suffix hints.
 */
export function inputFromId(id: string): ("text" | "image")[] {
	return VISION_RX.some((rx) => rx.test(id))
		? ["text", "image"]
		: ["text"];
}

export function reasoningFromId(id: string): boolean {
	return REASONING_RX.some((rx) => rx.test(id));
}

/**
 * Parse an `input` array from upstream JSON (e.g. ["text","image"]) when the
 * bridge provides one; otherwise fall back to the id-based heuristic.
 */
export function normalizeInput(raw: unknown, id: string): ("text" | "image")[] {
	if (Array.isArray(raw)) {
		const ok = raw.filter(
			(i: unknown): i is "text" | "image" => i === "text" || i === "image",
		);
		if (ok.length > 0) return ok;
	}
	return inputFromId(id);
}

/** owned_by → (suggested provider slug, default api). */
const SUGGESTED_GROUPS: Array<[Set<string>, string, Api]> = [
	[new Set(["zai"]), "glm", "openai-completions"],
	[new Set(["Mistral"]), "mistral", "openai-completions"],
	[new Set(["google", "antigravity"]), "gemini", "openai-completions"],
	[new Set(["Ollama", "Ollama pay"]), "ollama", "openai-completions"],
	[new Set(["Xiaomi"]), "mimo", "openai-completions"],
	[new Set(["OpenRouter"]), "openrouter", "openai-completions"],
	[new Set(["cerebras"]), "cerebras", "openai-completions"],
];

export function withProviderPrefix(
	prefix: string | undefined,
	suffix: string,
): string {
	const p = (prefix ?? "").trim();
	return p ? `${p}-${suffix}` : suffix;
}

/**
 * Server may suggest names with a legacy prefix.
 * Re-map them to the user's chosen prefix; if the user hasn't set one, drop
 * the legacy prefix entirely so we never surface our private namespace.
 */
export function normalizeSuggestedProvider(
	suggestedProvider: string,
	prefix: string | undefined,
): string {
	const p = (prefix ?? "").trim();
	const m = suggestedProvider.match(/^([a-z0-9]+-)(.*)$/);
	if (m) return p ? `${p}-${m[1]}` : m[1]!;
	return suggestedProvider;
}

export function classifyCustom(
	ownedBy: string,
	prefix?: string,
): { slug: string; api: Api } {
	for (const [owners, suffix, api] of SUGGESTED_GROUPS) {
		if (owners.has(ownedBy))
			return { slug: withProviderPrefix(prefix, suffix), api };
	}
	return {
		slug: withProviderPrefix(prefix, "misc"),
		api: "openai-completions",
	};
}

/** Make a friendly display name from an id like "glm-4.7" → "Glm 4.7". */
export function prettifyName(id: string): string {
	return id
		.replace(/[/:]/g, " ")
		.split(/[-_]/)
		.filter(Boolean)
		.map((p) => p[0]!.toUpperCase() + p.slice(1))
		.join(" ");
}

/** Build a CustomProviderModelConfig from a raw upstream model id + metadata. */
export function modelDefaults(id: string): CustomProviderModelConfig {
	return {
		id,
		name: prettifyName(id),
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		reasoning: reasoningFromId(id),
		input: inputFromId(id),
		cost: { ...DEFAULT_COST },
	};
}
