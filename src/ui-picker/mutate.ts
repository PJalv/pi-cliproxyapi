// State mutations + read helpers shared by the picker UI.
// Nothing in this module touches the rendering layer.

import type { Api } from "@earendil-works/pi-ai";

import type { CustomProviderModelConfig, ProxyConfig } from "../config.ts";
import type { CatalogIndex, ModelEntry, ProviderEntry } from "./types.ts";

/** model id \u2192 custom-provider slug that has claimed it (single owner). */
export function claimedBy(cfg: ProxyConfig): Map<string, string> {
	const m = new Map<string, string>();
	for (const [slug, p] of Object.entries(cfg.customProviders)) {
		for (const mm of p.models) m.set(mm.id, slug);
	}
	return m;
}

export function assignedIdsFor(
	cfg: ProxyConfig,
	prov: ProviderEntry,
): string[] {
	if (prov.kind === "builtin") {
		return [...(cfg.builtinProviders[prov.name]?.models ?? [])];
	}
	return cfg.customProviders[prov.name]?.models.map((m) => m.id) ?? [];
}

export function poolFor(
	cfg: ProxyConfig,
	prov: ProviderEntry,
	catalog: CatalogIndex,
): string[] {
	if (prov.kind === "builtin") {
		const ids = catalog.builtinModelIds.get(prov.name) ?? [];
		const assigned = new Set(assignedIdsFor(cfg, prov));
		return ids.filter((id) => !assigned.has(id));
	}
	const claim = claimedBy(cfg);
	const assigned = new Set(assignedIdsFor(cfg, prov));
	return catalog.customPoolIds.filter((id) => {
		if (assigned.has(id)) return false;
		const owner = claim.get(id);
		return owner === undefined || owner === prov.name;
	});
}

function toEntry(m: ModelEntry): CustomProviderModelConfig {
	return {
		id: m.id,
		name: m.name,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		reasoning: m.reasoning,
		input: m.input,
		cost: m.cost,
	};
}

export function attachModel(
	cfg: ProxyConfig,
	prov: ProviderEntry,
	model: ModelEntry,
): void {
	if (prov.kind === "builtin") {
		const cur = cfg.builtinProviders[prov.name] ?? {
			enabled: true,
			models: [],
		};
		const set = new Set(cur.models);
		set.add(model.id);
		cfg.builtinProviders[prov.name] = {
			enabled: true,
			apiOverride: cur.apiOverride ?? null,
			models: Array.from(set).sort(),
		};
		return;
	}
	// custom \u2014 exclusive: remove from any other custom group first.
	for (const [slug, p] of Object.entries(cfg.customProviders)) {
		if (slug === prov.name) continue;
		const i = p.models.findIndex((mm) => mm.id === model.id);
		if (i >= 0) p.models.splice(i, 1);
	}
	const cur = cfg.customProviders[prov.name] ?? { api: prov.api, models: [] };
	if (!cur.models.some((mm) => mm.id === model.id)) {
		cur.models.push(toEntry(model));
	}
	cfg.customProviders[prov.name] = cur;
}

export function detachModel(
	cfg: ProxyConfig,
	prov: ProviderEntry,
	modelId: string,
): void {
	if (prov.kind === "builtin") {
		const cur = cfg.builtinProviders[prov.name];
		if (!cur) return;
		cur.models = cur.models.filter((id) => id !== modelId);
		cur.enabled = cur.models.length > 0;
		return;
	}
	const cur = cfg.customProviders[prov.name];
	if (!cur) return;
	cur.models = cur.models.filter((mm) => mm.id !== modelId);
}

export function apiCompatible(provApi: Api, modelApi: Api): boolean {
	if (provApi === modelApi) return true;
	// openai-completions and openai-responses are siblings \u2014 most models work
	// with both, so don't warn when they differ.
	const openaiFamily: Api[] = ["openai-completions", "openai-responses"];
	if (openaiFamily.includes(provApi) && openaiFamily.includes(modelApi))
		return true;
	return false;
}

/** Group pool model ids by `ownedBy` (fallback: `origin`, then "misc"). */
export function groupPoolByOwnedBy(
	ids: string[],
	catalog: CatalogIndex,
): Array<{ label: string; ids: string[] }> {
	const groups = new Map<string, string[]>();
	for (const id of ids) {
		const m = catalog.byId.get(id);
		const key = m?.ownedBy || m?.origin || "misc";
		const arr = groups.get(key) ?? [];
		arr.push(id);
		groups.set(key, arr);
	}
	return Array.from(groups.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([label, arr]) => ({ label, ids: arr }));
}

/**
 * Substring filter over model id + display name (case-insensitive). Empty
 * query returns the input untouched. Used by the pool filter box.
 */
export function filterModelIds(
	ids: string[],
	catalog: CatalogIndex,
	query: string,
): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return ids;
	return ids.filter((id) => {
		if (id.toLowerCase().includes(q)) return true;
		const name = catalog.byId.get(id)?.name;
		return name ? name.toLowerCase().includes(q) : false;
	});
}

/**
 * Single source of truth for pool ordering: the grouped order flattened. The
 * picker MUST index navigation + activation through this so the visually
 * highlighted row always maps to the model that gets toggled. (Rendering
 * iterates the same `groupPoolByOwnedBy` groups, so indices line up exactly.)
 */
export function poolDisplayOrder(
	cfg: ProxyConfig,
	prov: ProviderEntry,
	catalog: CatalogIndex,
	filter = "",
): string[] {
	const ids = filterModelIds(poolFor(cfg, prov, catalog), catalog, filter);
	return groupPoolByOwnedBy(ids, catalog).flatMap((g) => g.ids);
}
