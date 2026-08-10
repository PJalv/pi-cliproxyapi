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
import { discoveryToIdSet } from "./fetch-models.ts";
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
	const proxyIds = discoveryToIdSet(discovery);
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
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			input?: ("text" | "image")[];
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
				cost: m.cost,
				input: m.input,
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
			if (!proxyIds.has(id)) continue;
			const c = catalogById.get(id);
			const px = proxyById.get(id);
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
			if (!px) continue;
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
		const present: CustomProviderModelConfig[] = c.models.filter((m) =>
			proxyIds.has(m.id),
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
			return {
				id: m.id,
				name: m.name ?? fromPool?.name ?? base.name ?? m.id,
				api: c.api,
				reasoning:
					pickBool(
						m.reasoning,
						fromPool?.reasoning,
						base.reasoning,
						ov.reasoning,
					) ?? false,
				input: m.input ?? fromPool?.input ?? ["text"],
				cost: m.cost ??
					fromPool?.cost ??
					base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow:
					pickNum(
						m.contextWindow,
						fromPool?.contextWindow,
						base.contextWindow,
						ov.contextWindow,
					) ?? 128000,
				maxTokens:
					pickNum(
						m.maxTokens,
						fromPool?.maxTokens,
						base.maxTokens,
						ov.maxTokens,
					) ?? 16000,
			};
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
