// Slash commands (2):
//   /cliproxy         — open the hub (Models / Usage / Diagnostics + actions)
//   /cliproxy-setup   — first-run / re-run wizard for endpoint+keys
//
// Refresh, usage, and diagnostics are now actions/tabs inside the hub.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { applyAll } from "./apply.ts";
import { autoAttachDiscovered } from "./auto-attach.ts";
import { loadConfig, resolveConfigValue, saveConfig } from "./config.ts";
import { fetchDiscovery } from "./fetch-models.ts";
import { clearUsageCache } from "./fetch-usage.ts";
import { runHub } from "./ui-hub/index.ts";
import { runSetup } from "./ui-setup.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cliproxy", {
		description:
			"Manage proxy models, usage, and diagnostics in one hub overlay",
		handler: handleCliproxy.bind(null, pi),
	});

	pi.registerCommand("cliproxy-setup", {
		description:
			"Set endpoint, API key, and (optional) usage key for the proxy",
		handler: handleSetup.bind(null, pi),
	});
}

// --------------------------------------------------------------------------- /cliproxy

async function handleCliproxy(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cfg = loadConfig();
	if (!cfg.proxy.endpoint || !resolveConfigValue(cfg.proxy.apiKey)) {
		ctx.ui.notify(
			"endpoint or API key not set \u2014 launching setup first",
			"info",
		);
		const ok = await runSetup(ctx, true);
		if (!ok) return;
	}
	const current = loadConfig();
	const resolvedKey = resolveConfigValue(current.proxy.apiKey);
	let discovery;
	try {
		discovery = await fetchDiscovery(current, resolvedKey);
	if (autoAttachDiscovered(current, discovery) > 0) saveConfig(current);
	} catch (err) {
		ctx.ui.notify(`discovery failed: ${(err as Error).message}`, "error");
		return;
	}
	await runHub(pi, ctx, current, discovery);
}

// --------------------------------------------------------------------------- /cliproxy-setup

async function handleSetup(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const ok = await runSetup(ctx, true);
	if (!ok) return;
	// After saving, eagerly reapply so the new endpoint/key actually takes effect.
	const cfg = loadConfig();
	try {
		const discovery = await fetchDiscovery(
			cfg,
			resolveConfigValue(cfg.proxy.apiKey),
		);
		if (autoAttachDiscovered(cfg, discovery) > 0) saveConfig(cfg);
		const rep = await applyAll(pi, cfg, discovery);
		clearUsageCache();
		ctx.ui.notify(
			`setup ok \u00b7 ${rep.registered.length} providers registered (source=${discovery.source})`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`setup saved, but apply failed: ${(err as Error).message}`,
			"warning",
		);
	}
}
