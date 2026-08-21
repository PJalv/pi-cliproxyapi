/**
 * pi-cliproxyapi — Pi extension that manages model providers through a single
 * CliProxyAPI endpoint with one corporate key.
 *
 * On factory boot we:
 *   1. load ~/.pi/agent/pi-cliproxyapi/config.json (migrates legacy config; defaults if missing)
 *   2. fetch discovery (well-known → fall back to /v1/models)
 *   3. call pi.registerProvider for each enabled built-in + custom provider
 *   4. register slash commands /cliproxy and /cliproxy-setup
 *      (refresh, usage, and diagnostics are tabs/actions inside the hub)
 *   5. register status-line quota segment (shared file cache, see usage-shared-cache)
 *
 * All discovery + apply errors are logged but never abort extension load —
 * a missing/broken proxy must not prevent Pi from starting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

import { applyAll } from "./src/apply.ts";
import { syncConfigWithDiscoveryReport } from "./src/auto-attach.ts";
import { readDiscoveryCache } from "./src/cache.ts";
import { registerCommands } from "./src/commands.ts";
import { loadConfig, resolveConfigValue, saveConfig } from "./src/config.ts";
import { detectConflicts } from "./src/conflicts.ts";
import { fetchDiscovery } from "./src/fetch-models.ts";
import type { ProxyConfig } from "./src/config.ts";
import type { UsageDocument } from "./src/fetch-usage.ts";
import {
	fetchUsage,
	lastUsageContract,
	lastUsageSource,
	PREFERRED_CONTRACT,
} from "./src/fetch-usage.ts";
import { log, setLogSink } from "./src/log.ts";
import {
	isUsageFresh,
	readUsageCache,
	releaseUsageLock,
	tryAcquireUsageLock,
	writeUsageCache,
} from "./src/usage-shared-cache.ts";
import { renderQuotaSegment } from "./src/status-quota.ts";

/** Status-line key. The leading "0" makes it sort before alphabetic keys so
 * the quota segment appears first on the footer's extension-status line. */
const QUOTA_STATUS_KEY = "0quota";
/** Minimum gap between network fetches triggered by turn_end, even if the
 * shared file cache is stale (prevents burst fetches during rapid turns). */
const TURN_FETCH_DEBOUNCE_MS = 5_000;

/** Guards the legacy-source warning so it appears once per session. */
let legacyUsageWarned = false;

/** Where an operator learns how to install or update the bridge plugin. */
const BRIDGE_DOCS_URL = "https://github.com/abix5/pi-cliproxyapi#pi-bridge";

/** Pi's taskflow children run in JSON/print mode and need providers only. */
export function isHeadlessRun(argv = process.argv): boolean {
	const modeIndex = argv.indexOf("--mode");
	const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined;
	return (
		mode === "json" ||
		mode === "print" ||
		argv.includes("-p") ||
		argv.includes("--print")
	);
}

/**
 * Fetch usage data through the shared file cache: if the on-disk cache is
 * fresh (within TTL), return it without any network call; otherwise acquire
 * a cross-process lock and fetch at most once. Returns the best available
 * doc (possibly stale) or null on failure.
 */
async function loadUsageCached(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	opts: { readOnly?: boolean } = {},
): Promise<UsageDocument | null> {
	const cached = readUsageCache();
	if (cached && isUsageFresh(cached.ageMs)) return cached.doc;
	// readOnly mode (debounce path): never fetch, serve stale cache if available.
	if (opts.readOnly) return cached?.doc ?? null;
	// Stale or missing — try to become the fetcher.
	const token = tryAcquireUsageLock();
	if (!token) {
		// Another instance is fetching; serve stale data if we have it.
		return cached?.doc ?? null;
	}
	try {
		const doc = await fetchUsage(cfg, resolvedUsageKey, { force: true });
		writeUsageCache(doc);
		return doc;
	} catch (e) {
		log.debug("usage fetch failed in shared cache:", (e as Error).message);
		return cached?.doc ?? null;
	} finally {
		releaseUsageLock(token);
	}
}

/**
 * Refresh discovery over the network after the cached copy was applied.
 *
 * The extension handle captured at startup becomes invalid once pi replaces or
 * reloads the session, so a slow refresh that finishes afterwards must not try
 * to register providers with it. That case is expected, not an error.
 */
async function revalidateDiscovery(
	pi: ExtensionAPI,
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<void> {
	try {
		const fresh = await fetchDiscovery(cfg, resolvedKey);
		const sync = syncConfigWithDiscoveryReport(cfg, fresh);
		if (sync.added > 0 || sync.removed > 0) saveConfig(cfg);
		await applyAll(pi, cfg, fresh);
		log.debug("discovery revalidated from network");
	} catch (e) {
		const message = (e as Error).message ?? "";
		if (message.includes("stale after session replacement")) {
			log.debug("discovery revalidate skipped: session was replaced");
			return;
		}
		log.warn("background discovery revalidate failed:", message);
	}
}

/** Warn once per session when quota still comes from a pre-contract source, so
 * a deprecated path is visible rather than silently permanent. */
function warnIfLegacyUsageSource(ui: {
	notify(message: string, level: "info" | "warning" | "error"): void;
}): void {
	if (legacyUsageWarned) return;
	const source = lastUsageSource();
	const contract = lastUsageContract();
	if (source === null) return;

	if (source === "sidecar") {
		legacyUsageWarned = true;
		ui.notify(
			"quota is served by the legacy pi-cliproxyapi-wellknown sidecar. " +
				"Install the pi-bridge plugin in CLIProxyAPI to use your normal API key " +
				`and drop proxy.usageKey: ${BRIDGE_DOCS_URL}`,
			"warning",
		);
		return;
	}
	if (contract !== null && contract < PREFERRED_CONTRACT) {
		legacyUsageWarned = true;
		ui.notify(
			`the pi-bridge plugin answered with contract v${contract}; this extension ` +
				`prefers v${PREFERRED_CONTRACT}. Quota still works, but update the plugin ` +
				`in CLIProxyAPI for cache and account details: ${BRIDGE_DOCS_URL}`,
			"warning",
		);
	}
}

/** Update the quota status segment for the current model. No-op if the model
 * has no quota windows (e.g. a custom provider) or if usage is unavailable. */
async function refreshQuotaStatus(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	ui: {
		theme: {
			fg(color: "success" | "warning" | "error" | "dim", text: string): string;
		};
		setStatus(key: string, text: string | undefined): void;
	},
	model: { provider: string; id?: string } | undefined,
	opts: { readOnly?: boolean } = {},
): Promise<void> {
	if (!model) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const doc = await loadUsageCached(cfg, resolvedUsageKey, opts);
	if (!doc) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const rendered = renderQuotaSegment(doc, model.provider, ui.theme, model.id);
	ui.setStatus(QUOTA_STATUS_KEY, rendered ?? undefined);
}

/**
 * True when THIS module is the globally-installed copy (its file lives under a
 * `node_modules` tree), as opposed to a working-tree checkout.
 */
function isInstalledCopy(): boolean {
	try {
		return import.meta.url.includes("/node_modules/");
	} catch {
		return false;
	}
}

/**
 * True when the current project is a dev checkout of this extension that loads
 * its own working-tree source through `.pi/extensions/cliproxyapi.ts`.
 */
function localDevLoaderPresent(cwd: string): boolean {
	try {
		return (
			fs.existsSync(path.join(cwd, ".pi", "extensions", "cliproxyapi.ts")) &&
			fs.existsSync(path.join(cwd, "src", "fetch-usage.ts"))
		);
	} catch {
		return false;
	}
}

export default async function cliproxyapi(pi: ExtensionAPI): Promise<void> {
	// Mode guard: inside this extension's own checkout the project-local loader
	// already supplies the working-tree source. If the published package is also
	// installed globally, both copies would load in one process and register the
	// same providers twice, so the installed copy stands down and the dev source
	// wins.
	if (isInstalledCopy() && localDevLoaderPresent(process.cwd())) {
		return;
	}

	const headless = isHeadlessRun();
	if (!headless) registerCommands(pi);

	// Route later messages through pi's notification channel. Startup runs before
	// any session exists, so those messages have no UI to reach and are kept off
	// the terminal instead (see log.ts).
	pi.on("session_start", (_event, ctx) => {
		setLogSink(ctx.hasUI ? ctx.ui : null);
	});

	const cfg = loadConfig();
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.warn(
			"apiKey is empty after resolution — skipping initial apply. Run /cliproxy-setup to configure.",
		);
		return;
	}

	// Conflict scanning only feeds the interactive diagnostics UI.
	if (!headless) {
		const conflicts = detectConflicts(cfg);
		for (const c of conflicts) log.warn(`conflict (${c.kind}): ${c.detail}`);
	}

	try {
		const cached = readDiscoveryCache();
		if (cached) {
			// Serve the last good discovery instantly so Pi startup never blocks on
			// the ~5s proxy round-trip, then revalidate over the network in the
			// background (applyAll is idempotent — it just re-registers providers).
			log.info(
				`discovery from cache (age ${Math.round(cached.ageMs / 1000)}s): ${cached.discovery.builtinProviders.length} builtin, ${cached.discovery.customPool.length} custom`,
			);
			await applyAll(pi, cfg, cached.discovery);
			if (!headless) {
				// Revalidate in the background, but bind the work to the session
				// that started it: pi invalidates the extension handle when the
				// session is replaced or reloaded, and using a captured handle
				// afterwards throws.
				void revalidateDiscovery(pi, cfg, resolvedKey);
			}
		} else if (headless) {
			log.warn(
				"discovery cache missing in headless run — no providers registered",
			);
		} else {
			const discovery = await fetchDiscovery(cfg, resolvedKey);
			const sync = syncConfigWithDiscoveryReport(cfg, discovery);
			if (sync.added > 0 || sync.removed > 0) saveConfig(cfg);
			await applyAll(pi, cfg, discovery);
		}
	} catch (err) {
		log.error("initial apply failed:", (err as Error).message);
		// Commands stay registered; user can open /cliproxy and press r to refresh.
	}

	if (!headless && cfg.refreshIntervalMinutes > 0) {
		const ms = cfg.refreshIntervalMinutes * 60_000;
		setInterval(() => {
			void (async () => {
				try {
					const c = loadConfig();
					const k = resolveConfigValue(c.proxy.apiKey);
					if (!k) return;
					const d = await fetchDiscovery(c, k);
					const sync = syncConfigWithDiscoveryReport(c, d);
					if (sync.added > 0 || sync.removed > 0) saveConfig(c);
					await applyAll(pi, c, d);
					log.debug("background refresh ok");
				} catch (e) {
					log.warn("background refresh failed:", (e as Error).message);
				}
			})();
		}, ms);
		log.info(`background refresh every ${cfg.refreshIntervalMinutes}m`);
	}

	// -------- status-line quota segment
	//
	// The segment is context-aware: it shows 5h/7d windows for the current
	// model's provider only (anthropic→claude, openai→codex, custom→hidden).
	// The shared file cache ensures multiple Pi instances don't fetch more than
	// once every 2 minutes.
	const resolvedUsageKey = headless
		? ""
		: resolveConfigValue(cfg.proxy.usageKey);
	// Quota is available through the pi-bridge plugin (ordinary API key) or the
	// legacy sidecar (separate usage key), so either credential enables it.
	if (resolvedUsageKey || cfg.proxy.apiKey) {
		let lastTurnFetchMs = 0;

		// session_start: render immediately from cache (no fetch needed if fresh).
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model);
			warnIfLegacyUsageSource(ctx.ui);
		});

		// model_select: re-render for the new provider. Read from cache so the
		// segment updates instantly on model switch without a network round-trip.
		pi.on("model_select", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model);
		});

		// turn_end: after an LLM response the quota has changed. Trigger a fetch
		// (if the shared cache is stale) but debounce to avoid burst-fetching on
		// rapid consecutive turns.
		pi.on("turn_end", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			const now = Date.now();
			if (now - lastTurnFetchMs < TURN_FETCH_DEBOUNCE_MS) {
				// Within debounce window — re-render from cache only (no fetch), so
				// rapid consecutive turns never trigger burst /api/usage calls.
				await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model, {
					readOnly: true,
				});
				return;
			}
			lastTurnFetchMs = now;
			await refreshQuotaStatus(cfg, resolvedUsageKey, ctx.ui, ctx.model);
		});
	} else {
		log.debug("usageKey not configured — quota status segment disabled");
	}
}
