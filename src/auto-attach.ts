// Auto-attach: after a discovery fetch, merge models the bridge newly started
// serving into a configured custom-provider group so they become active
// without manual hub interaction.
//
// Opt-in via config: "autoAttachTo": "<customProviderKey>" (e.g. "cliproxy-group").
// Only custom-pool models that are not already assigned to any group are added
// (the same exclusivity rule the hub picker uses); the target group is created
// with api "openai-completions" if it does not exist yet.

import type { CustomProviderModelConfig, ProxyConfig } from "./config.ts";
import type { Discovery } from "./fetch-models.ts";
import { log } from "./log.ts";

/**
 * Add every discovery custom-pool model that isn't already assigned anywhere
 * to the group named by cfg.autoAttachTo. Returns the number of models added.
 */
export function autoAttachDiscovered(
	cfg: ProxyConfig,
	discovery: Discovery,
): number {
	const target = cfg.autoAttachTo?.trim();
	if (!target) return 0;

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

	let added = 0;
	for (const m of discovery.customPool) {
		if (claimed.has(m.id)) continue;
		const entry: CustomProviderModelConfig = {
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			input: m.input,
			cost: m.cost,
		};
		group.models.push(entry);
		claimed.add(m.id);
		added++;
	}

	if (added > 0) {
		log.info(
			`autoAttach: added ${added} newly discovered model(s) to "${target}"`,
		);
	}
	return added;
}
