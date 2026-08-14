// /cliproxy hub — one overlay with Models / Usage / Diagnostics tabs and a
// shared action bar. Replaces the old per-command overlays (-refresh, -usage,
// -doctor) with global keys inside a single surface.
//
//   global keys: [ ] / 1 2 3 switch tab \u00b7 r refresh \u00b7 e setup \u00b7 s save \u00b7 q close
//   per-view keys: see each view's footerHint()

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
} from "@earendil-works/pi-tui";

import { applyAll } from "../apply.ts";
import { autoAttachDiscovered } from "../auto-attach.ts";
import type { ProxyConfig } from "../config.ts";
import { loadConfig, resolveConfigValue, saveConfig } from "../config.ts";
import type { Discovery } from "../fetch-models.ts";
import { fetchDiscovery } from "../fetch-models.ts";
import { clearUsageCache } from "../fetch-usage.ts";
import { frame } from "../ui-frame.ts";
import type { OverlayTui, Theme } from "../ui-picker/types.ts";
import { runSetup } from "../ui-setup.ts";
import { ruleLine, statusHeader, tabBar } from "./shell.ts";
import type { HubView } from "./types.ts";
import { buildDiagnosticsView } from "./view-diagnostics.ts";
import { buildModelsView, type ModelsView } from "./view-models.ts";
import { buildUsageView, type UsageView } from "./view-usage.ts";

export interface HubDeps {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	tui: OverlayTui;
	theme: Theme;
	cfg: ProxyConfig; // mutable draft owned by the hub
	discovery: Discovery;
	done: () => void;
}

export function buildHub(
	deps: HubDeps,
): Component & { handleInput(data: string): void } {
	const { pi, ctx, tui, theme, cfg, done } = deps;
	let discovery = deps.discovery;
	let dirty = false; // unsaved config changes
	let flash = ""; // transient status message (save/refresh/setup feedback)

	const models: ModelsView = buildModelsView({
		tui,
		theme,
		ctx,
		cfg,
		getDiscovery: () => discovery,
		onChange: () => {
			dirty = true;
			flash = "";
		},
	});
	const usage: UsageView = buildUsageView({ tui, theme, cfg });
	const diagnostics: HubView = buildDiagnosticsView({
		theme,
		cfg,
		getDiscovery: () => discovery,
	});
	const views: HubView[] = [models, usage, diagnostics];
	let activeIdx = 0;
	const active = (): HubView => views[activeIdx]!;

	const switchTab = (idx: number): void => {
		if (idx < 0 || idx >= views.length || idx === activeIdx) return;
		activeIdx = idx;
		active().onActivate?.();
		tui.requestRender();
	};

	const save = (): void => {
		flash = theme.fg("dim", "saving\u2026");
		saveConfig(cfg);
		tui.requestRender();
		void applyAll(pi, cfg, discovery)
			.then((rep) => {
				dirty = false;
				flash = theme.fg(
					"success",
					`\u2713 settings saved \u00b7 ${rep.registered.length} registered, ${rep.skipped.length} skipped`,
				);
				tui.requestRender();
			})
			.catch((e: unknown) => {
				flash = theme.fg("error", `save failed: ${(e as Error).message}`);
				tui.requestRender();
			});
	};

	const refresh = async (): Promise<void> => {
		flash = theme.fg("dim", "refreshing\u2026");
		tui.requestRender();
		try {
			const key = resolveConfigValue(cfg.proxy.apiKey);
			discovery = await fetchDiscovery(cfg, key);
			if (autoAttachDiscovered(cfg, discovery) > 0) saveConfig(cfg);
			clearUsageCache();
			models.rebuild();
			usage.reload();
			const rep = await applyAll(pi, cfg, discovery);
			flash = theme.fg(
				"success",
				`\u2713 refreshed \u00b7 ${rep.registered.length} providers (${discovery.source})`,
			);
		} catch (e) {
			flash = theme.fg("error", `refresh failed: ${(e as Error).message}`);
		}
		tui.requestRender();
	};

	const setup = async (): Promise<void> => {
		const ok = await runSetup(ctx, true);
		if (!ok) {
			tui.requestRender();
			return;
		}
		// Pull fresh credentials but keep the user's in-hub model edits.
		const reloaded = loadConfig();
		cfg.proxy = { ...cfg.proxy, ...reloaded.proxy };
		await refresh();
	};

	// ----- chrome ------------------------------------------------------------
	const statusParts = (): string[] => {
		const ep = cfg.proxy.endpoint || "(unset)";
		const epShort = ep.length > 40 ? `\u2026${ep.slice(-39)}` : ep;
		const keyOk = Boolean(resolveConfigValue(cfg.proxy.apiKey));
		let provCount = 0;
		let modelCount = 0;
		for (const p of Object.values(cfg.builtinProviders)) {
			if (p.enabled && p.models.length > 0) provCount++;
			modelCount += p.models.length;
		}
		for (const p of Object.values(cfg.customProviders)) {
			if (p.models.length > 0) provCount++;
			modelCount += p.models.length;
		}
		const state = flash
			? flash
			: dirty
				? theme.fg("warning", "\u25cf unsaved \u2014 press s to save")
				: theme.fg("dim", "\u2713 saved");
		return [
			`${theme.fg("dim", "endpoint")} ${epShort}`,
			`${theme.fg("dim", "key")} ${keyOk ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717")}`,
			`${theme.fg("dim", "providers")} ${provCount}`,
			`${theme.fg("dim", "models")} ${modelCount}`,
			state,
		];
	};

	const render = (width: number): string[] => {
		const totalRows = tui.rows ?? 40;
		// frame() adds a top + bottom border, so the lines we hand it must total
		// `frameTotal - 2`. Keep frameTotal within the overlay's 94% budget
		// (proven range 16\u201338) so the box never overflows and gets clipped
		// \u2014 clipping is what made the top unreachable and shifted the window.
		const frameTotal = Math.max(16, Math.min(totalRows - 6, 38));
		const bodyRows = frameTotal - 2;
		const inner = Math.max(72, width - 2);
		const viewBodyH = Math.max(6, bodyRows - 3); // minus status + tab + rule

		const lines: string[] = [];
		lines.push(statusHeader(theme, statusParts(), inner));
		lines.push(
			tabBar(
				theme,
				views.map((v) => ({ id: v.id, label: v.label })),
				activeIdx,
				inner,
			),
		);
		lines.push(ruleLine(theme, inner));
		lines.push(...active().render(inner, viewBodyH));

		return frame(theme, {
			width,
			title: " /cliproxy ",
			lines,
			footer: {
				hint: active().footerHint(),
				badge:
					" [ ] tab \u00b7 r refresh \u00b7 e setup \u00b7 s save \u00b7 q close ",
			},
		});
	};

	// ----- input -------------------------------------------------------------
	const globalInput = (data: string): boolean | Promise<boolean> => {
		const kb = getKeybindings();
		if (
			kb.matches(data, "tui.select.cancel") ||
			matchesKey(data, "q") ||
			matchesKey(data, "escape")
		) {
			done();
			return true;
		}
		if (matchesKey(data, "]") || matchesKey(data, "tab")) {
			switchTab((activeIdx + 1) % views.length);
			return true;
		}
		if (matchesKey(data, "[") || matchesKey(data, "shift+tab")) {
			switchTab((activeIdx - 1 + views.length) % views.length);
			return true;
		}
		if (matchesKey(data, "1")) {
			switchTab(0);
			return true;
		}
		if (matchesKey(data, "2")) {
			switchTab(1);
			return true;
		}
		if (matchesKey(data, "3")) {
			switchTab(2);
			return true;
		}
		if (matchesKey(data, "r")) return refresh().then(() => true);
		if (matchesKey(data, "e")) return setup().then(() => true);
		if (matchesKey(data, "s")) {
			save();
			return true;
		}
		return false;
	};

	return {
		render,
		invalidate(): void {
			/* stateless */
		},
		handleInput(data: string): void {
			const handled = active().handleInput(data);
			if (handled instanceof Promise) {
				flash = "";
				void handled.then((h) => {
					if (h) tui.requestRender();
				});
				return;
			}
			if (handled) {
				flash = ""; // editing/navigating clears stale save feedback
				tui.requestRender();
				return;
			}
			const g = globalInput(data);
			if (g instanceof Promise) {
				void g.then((h) => {
					if (h) tui.requestRender();
				});
			} else if (g) {
				tui.requestRender();
			}
		},
	};
}
