// Config sync: after a discovery fetch, make the configured model lists match
// what the proxy actually serves — add models that newly appear and remove
// models that no longer do.
//
// Opt-in via config: "autoAttachTo": "<customProviderKey>" (e.g. "cliproxy-group").
// Only custom-pool models that are not already assigned to any group are added
// (the same exclusivity rule the hub picker uses); the target group is created
// with api "openai-completions" if it does not exist yet.
//
// Removal is unconditional (independent of autoAttachTo): a model that
// disappeared upstream is dropped from every group, and user-set metadata
// (names, costs, context windows, overrides) is preserved for models that
// survive so a round trip never loses configuration.

import type {
	CustomProviderModelConfig,
	ProxyConfig,
} from "./config.ts";
import type { Discovery, DiscoveryModelEntry } from "./fetch-models.ts";
import { resolveInput } from "./compat.ts";
import { log } from "./log.ts";

/** Result of syncing one config against a fresh discovery. */
export interface SyncReport {
	/** Custom-pool models added to the auto-attach target group. */
	added: number;
	/** Configured model ids removed because the proxy no longer serves them. */
	removed: number;
	/** Removed ids, for logging and UI feedback. */
	removedIds: string[];
}

/**
 * Add every discovery custom-pool model that isn't already assigned anywhere
 * to the group named by cfg.autoAttachTo, and remove every configured model
 * the proxy no longer serves. Returns the number of models added.
 */
export function autoAttachDiscovered(
	cfg: ProxyConfig,
	discovery: Discovery,
): number {
	return syncConfigWithDiscoveryReport(cfg, discovery).added;
}

/**
 * Sync configured model lists with a fresh discovery.
 *
 * - custom groups: drop entries missing from the custom pool; keep user-set
 *   metadata for models that survive (discovery metadata is only filled in
 *   when a field was never set by the user)
 * - auto-attach target: add unclaimed custom-pool models
 * - builtin whitelists: drop ids the proxy no longer serves
 *
 * Returns the number of models added to the auto-attach group.
 */
export function syncConfigWithDiscovery(
	cfg: ProxyConfig,
	discovery: Discovery,
): number {
	return syncConfigWithDiscoveryReport(cfg, discovery).added;
}

/** Sync and report both what was added and what was removed. */
export function syncConfigWithDiscoveryReport(
	cfg: ProxyConfig,
	discovery: Discovery,
): SyncReport {
	const removed: string[] = [];

	// ----- custom groups: remove stale, refresh metadata, then auto-attach ----
	const poolById = new Map(discovery.customPool.map((m) => [m.id, m]));
	for (const p of Object.values(cfg.customProviders)) {
		const next: CustomProviderModelConfig[] = [];
		for (const entry of p.models) {
			const up = poolById.get(entry.id);
			if (!up) {
				removed.push(entry.id);
				continue;
			}
			next.push({ ...entry, ...mergeKept(entry, up) });
		}
		p.models = next;
	}

	let added = 0;
	const target = cfg.autoAttachTo?.trim();
	if (target) {
		if (!cfg.customProviders[target]) {
			log.info(`autoAttach: creating missing custom provider "${target}"`);
			cfg.customProviders[target] = { api: "openai-completions", models: [] };
		}
		const group = cfg.customProviders[target]!;

		// Models are exclusive to one group (same rule as the picker pool).
		const claimed = new Set<string>();
		for (const p of Object.values(cfg.customProviders)) {
			for (const m of p.models) claimed.add(m.id);
		}

		for (const m of discovery.customPool) {
			if (claimed.has(m.id)) continue;
			const ov = cfg.overrides[m.id];
			const entry: CustomProviderModelConfig = {
				id: m.id,
				name: ov?.name ?? m.name,
				reasoning: ov?.reasoning ?? m.reasoning,
				contextWindow: ov?.contextWindow ?? m.contextWindow,
				maxTokens: ov?.maxTokens ?? m.maxTokens,
				input: ov?.input ?? resolveInput(m.input, m.id),
				cost: ov?.cost ?? m.cost,
			};
			group.models.push(entry);
			claimed.add(m.id);
			added++;
		}
	}

	// ----- builtin whitelists --------------------------------------------------
	const builtinIds = new Set<string>();
	for (const p of discovery.builtinProviders) {
		for (const m of p.models) builtinIds.add(m.id);
	}
	for (const p of Object.values(cfg.builtinProviders)) {
		const before = p.models.length;
		p.models = p.models.filter((id) => {
			const keep = builtinIds.has(id);
			if (!keep) removed.push(id);
			return keep;
		});
		if (p.models.length < before) {
			log.info(
				`autoAttach: pruned ${before - p.models.length} missing model(s) from a builtin group`,
			);
		}
	}

	if (added > 0) {
		log.info(`autoAttach: added ${added} newly discovered model(s) to "${target}"`);
	}
	if (removed.length > 0) {
		log.info(`autoAttach: removed ${removed.length} model(s) no longer served: ${removed.join(", ")}`);
	}
	return { added, removed: removed.length, removedIds: removed };
}

/**
 * Field-by-field merge: user-set metadata wins; discovery metadata fills in
 * only when the configured value is absent or zero.
 */
function mergeKept(
	entry: CustomProviderModelConfig,
	up: DiscoveryModelEntry,
): Partial<CustomProviderModelConfig> {
	const cost =
		entry.cost &&
		(entry.cost.input || entry.cost.output || entry.cost.cacheRead || entry.cost.cacheWrite)
			? entry.cost
			: up.cost;
	return {
		name: entry.name ?? up.name,
		reasoning: entry.reasoning ?? up.reasoning,
		contextWindow:
			typeof entry.contextWindow === "number" && entry.contextWindow > 0
				? entry.contextWindow
				: up.contextWindow,
		maxTokens:
			typeof entry.maxTokens === "number" && entry.maxTokens > 0
				? entry.maxTokens
				: up.maxTokens,
		input: entry.input ?? up.input,
		cost,
	};
}
