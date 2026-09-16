// applyAll: take a fully-loaded config + a fresh Discovery and call
// pi.registerProvider for each enabled builtin + each custom provider.

import type { Api } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

import { ALLOWED_APIS, baseUrlFor, modelDefaults } from "./compat.ts";
import type { CustomProviderModelConfig, ProxyConfig } from "./config.ts";
import { resolveConfigValue } from "./config.ts";
import type { Discovery, DiscoveryCustomEntry } from "./fetch-models.ts";
import { log } from "./log.ts";

export interface ApplyReport {
	registered: Array<{ provider: string; modelCount: number; api: Api }>;
	skipped: Array<{ provider: string; reason: string }>;
}

export async function applyAll(
	pi: ExtensionAPI,
	cfg: ProxyConfig,
	discovery: Discovery,
): Promise<ApplyReport> {
	const report: ApplyReport = { registered: [], skipped: [] };
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.warn(
			"proxy apiKey is empty — pi.registerProvider calls will be skipped",
		);
		return report;
	}

	// -------- builtin providers (anthropic, openai, etc.)
	const builtinByName = new Map<
		string,
		Array<{
			id: string;
			name: string;
			reasoning: boolean;
			contextWindow: number;
			maxTokens: number;
			input?: ("text" | "image")[];
			thinkingLevelMap?: Record<string, string>;
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
		}>
	>();
	for (const p of discovery.builtinProviders) {
		builtinByName.set(
			p.name,
			p.models.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				input: m.input,
				thinkingLevelMap: m.thinkingLevelMap,
				cost: m.cost,
			})),
		);
	}

	for (const [name, p] of Object.entries(cfg.builtinProviders)) {
		if (!p?.enabled) {
			report.skipped.push({ provider: name, reason: "disabled" });
			continue;
		}
		if (!Array.isArray(p.models) || p.models.length === 0) {
			report.skipped.push({ provider: name, reason: "empty whitelist" });
			continue;
		}
		let catalog: ReadonlyArray<{
			id: string;
			name: string;
			api: Api;
			reasoning: boolean;
			input: ("text" | "image")[];
			cost: any;
			contextWindow: number;
			maxTokens: number;
			thinkingLevelMap?: any;
		}> = [];
		try {
			catalog = getModels(name as any) as any;
		} catch {
			/* unknown provider in pi-ai catalog — keep going with proxy data */
		}
		const catalogById = new Map(catalog.map((m) => [m.id, m]));
		const proxyById = new Map(
			(builtinByName.get(name) ?? []).map((m) => [m.id, m]),
		);

		interface MergedModel {
			id: string;
			name: string;
			reasoning: boolean;
			contextWindow: number;
			maxTokens: number;
			cost: any;
			input: ("text" | "image")[];
			api: Api;
			thinkingLevelMap?: any;
		}
		const selected: MergedModel[] = [];
		for (const id of p.models) {
			// A whitelist entry only exists if the proxy still serves it —
			// the pi-ai static catalog is metadata, never a source of truth.
			const px = proxyById.get(id);
			if (!px) continue;
			const c = catalogById.get(id);
			if (c) {
				selected.push({
					id: c.id,
					name: c.name,
					reasoning: c.reasoning,
					contextWindow: c.contextWindow,
					maxTokens: c.maxTokens,
					cost: c.cost,
					input: c.input,
					api: c.api,
					thinkingLevelMap: c.thinkingLevelMap,
				});
				continue;
			}
			// Catalog miss — fall back to proxy metadata. Pick API by provider name.
			const api: Api =
				name === "anthropic"
					? "anthropic-messages"
					: ((p.apiOverride as Api | undefined) ?? "openai-responses");
			selected.push({
				id: px.id,
				name: px.name,
				reasoning: px.reasoning,
				contextWindow: px.contextWindow,
				maxTokens: px.maxTokens,
				cost: px.cost,
				input: px.input ?? ["text"],
				api,
				thinkingLevelMap: px.thinkingLevelMap,
			});
		}
		if (selected.length === 0) {
			report.skipped.push({
				provider: name,
				reason: "no whitelisted models present on proxy",
			});
			continue;
		}
		const api: Api = (p.apiOverride ?? selected[0]!.api) as Api;
		if (!ALLOWED_APIS.has(api)) {
			report.skipped.push({
				provider: name,
				reason: `api "${api}" not in allowlist`,
			});
			continue;
		}
		const modelDefs: ProviderModelConfig[] = selected.map((m) => {
			const ov = cfg.overrides[m.id] ?? {};
			const base: ProviderModelConfig = {
				id: m.id,
				name: typeof ov.name === "string" ? ov.name : m.name,
				api,
				reasoning:
					typeof ov.reasoning === "boolean" ? ov.reasoning : m.reasoning,
				input: m.input,
				cost: ov.cost ?? m.cost,
				contextWindow:
					typeof ov.contextWindow === "number"
						? ov.contextWindow
						: m.contextWindow,
				maxTokens:
					typeof ov.maxTokens === "number" ? ov.maxTokens : m.maxTokens,
			};
			if (m.thinkingLevelMap) base.thinkingLevelMap = m.thinkingLevelMap;
			return base;
		});
		const providerConfig: ProviderConfig = {
			name,
			baseUrl: baseUrlFor(api, cfg.proxy.endpoint),
			apiKey: resolvedKey,
			authHeader: true,
			api,
			models: modelDefs,
		};
		pi.registerProvider(name, providerConfig);
		report.registered.push({
			provider: name,
			modelCount: modelDefs.length,
			api,
		});
	}

	// -------- custom providers
	const proxyCustomById = new Map<string, DiscoveryCustomEntry>(
		discovery.customPool.map((m) => [m.id, m]),
	);
	for (const [name, c] of Object.entries(cfg.customProviders)) {
		if (!ALLOWED_APIS.has(c.api)) {
			report.skipped.push({
				provider: name,
				reason: `api "${c.api}" not in allowlist`,
			});
			continue;
		}
		const present: CustomProviderModelConfig[] = c.models.filter(
			(m) => proxyCustomById.has(m.id),
		);
		if (present.length === 0) {
			report.skipped.push({
				provider: name,
				reason: "no configured models present on proxy",
			});
			continue;
		}
		const modelDefs: ProviderModelConfig[] = present.map((m) => {
			const fromPool = proxyCustomById.get(m.id);
			const base = modelDefaults(m.id);
			const ov = cfg.overrides[m.id] ?? {};
			const model: ProviderModelConfig = {
				id: m.id,
				name: fromPool?.name ?? m.name ?? base.name ?? m.id,
				api: c.api,
				// Live bridge metadata wins over the persisted discovery snapshot.
				reasoning:
					pickBool(
						fromPool?.reasoning,
						m.reasoning,
						base.reasoning,
						ov.reasoning,
					) ?? false,
				input:
					pickInput(ov.input, fromPool?.input, m.input, base.input) ??
						["text"],
				cost: fromPool?.cost ??
					m.cost ??
					base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow:
					pickNum(
						fromPool?.contextWindow,
						m.contextWindow,
						base.contextWindow,
						ov.contextWindow,
					) ?? 128000,
				maxTokens:
					pickNum(
						fromPool?.maxTokens,
						m.maxTokens,
						base.maxTokens,
						ov.maxTokens,
					) ?? 16000,
			};
			if (fromPool?.thinkingLevelMap) {
				model.thinkingLevelMap = fromPool.thinkingLevelMap;
			}
			return model;
		});
		const providerConfig: ProviderConfig = {
			name,
			baseUrl: baseUrlFor(c.api, cfg.proxy.endpoint),
			apiKey: resolvedKey,
			authHeader: true,
			api: c.api,
			models: modelDefs,
		};
		pi.registerProvider(name, providerConfig);
		report.registered.push({
			provider: name,
			modelCount: modelDefs.length,
			api: c.api,
		});
	}

	log.info(
		`applyAll: registered ${report.registered.length} providers, skipped ${report.skipped.length}`,
	);
	return report;
}

function pickNum(...vals: Array<number | undefined>): number | undefined {
	for (const v of vals) if (typeof v === "number") return v;
	return undefined;
}
function pickBool(...vals: Array<boolean | undefined>): boolean | undefined {
	for (const v of vals) if (typeof v === "boolean") return v;
	return undefined;
}

/**
 * Input modality precedence: explicit overrides first, then FRESH discovery
 * (fromPool) ahead of the stale stored entry (m.input). A model that was
 * auto-attached when the bridge reported text-only must re-advertise image
 * support once the bridge catches up, rather than being pinned to the old
 * concrete value. The stored entry still wins over the id-inference base.
 */
function pickInput(
	...vals: Array<readonly ("text" | "image")[] | undefined>
): ("text" | "image")[] | undefined {
	for (const v of vals)
		if (Array.isArray(v) && v.length > 0) return [...v];
	return undefined;
}
