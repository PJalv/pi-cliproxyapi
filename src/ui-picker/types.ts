// Shared types for the /cliproxy three-panel picker.

import type { Api } from "@earendil-works/pi-ai";

export interface Theme {
	fg(name: string, s: string): string;
	bold(s: string): string;
}

export interface OverlayTui {
	requestRender(): void;
	rows?: number;
	cols?: number;
}

export type PanelId = "providers" | "assigned" | "pool";

export interface ProviderEntry {
	kind: "builtin" | "custom";
	name: string;
	/** API the provider expects. Used for compat warnings on pool rows. */
	api: Api;
	/** Subtitle shown in the providers panel. */
	subtitle: string;
}

export interface ModelEntry {
	id: string;
	name: string;
	/** Suggested API for this model (from server hint / catalog). */
	suggestedApi: Api;
	/** Subtitle to render. */
	subtitle?: string;
	/** Origin label for grouping (e.g. "lproxy-glm"); empty for built-in. */
	origin?: string;
	/** Raw upstream owned_by tag, for grouping/UX. */
	ownedBy?: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input?: ("text" | "image")[];
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface CatalogIndex {
	/** All models indexed by id, regardless of provider scope. */
	byId: Map<string, ModelEntry>;
	/** For each built-in provider name, ordered model ids that it offers on the proxy. */
	builtinModelIds: Map<string, string[]>;
	/** Ordered list of all custom-pool model ids. */
	customPoolIds: string[];
}
