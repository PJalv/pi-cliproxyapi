// Build a fast lookup of every model the proxy currently offers, split into
// built-in (by provider name) and the custom pool. The result is consumed by
// providers.ts and mutate.ts.

import type { Discovery } from "../fetch-models.ts";
import type { CatalogIndex, ModelEntry } from "./types.ts";

export function buildCatalog(discovery: Discovery): CatalogIndex {
	const byId = new Map<string, ModelEntry>();
	const builtinModelIds = new Map<string, string[]>();

	for (const p of discovery.builtinProviders) {
		const ids: string[] = [];
		for (const m of p.models) {
			byId.set(m.id, {
				id: m.id,
				name: m.name,
				suggestedApi: p.api,
				subtitle: m.name && m.name !== m.id ? m.name : undefined,
				ownedBy: p.name,
				reasoning: m.reasoning,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				input: m.input,
				cost: m.cost,
			});
			ids.push(m.id);
		}
		builtinModelIds.set(p.name, ids);
	}

	const customPoolIds: string[] = [];
	for (const m of discovery.customPool) {
		// Don't overwrite a built-in entry if the same id appears in both.
		if (!byId.has(m.id)) {
			byId.set(m.id, {
				id: m.id,
				name: m.name,
				suggestedApi: m.api,
				subtitle: m.name && m.name !== m.id ? m.name : undefined,
				origin: m.suggestedProvider,
				ownedBy: m.ownedBy,
				reasoning: m.reasoning,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				input: m.input,
				cost: m.cost,
			});
		}
		customPoolIds.push(m.id);
	}

	return { byId, builtinModelIds, customPoolIds };
}
