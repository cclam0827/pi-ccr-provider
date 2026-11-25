import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const PROVIDER_ID = "ccr";
const DEFAULT_BASE_URL = "http://127.0.0.1:3456/v1";
const DEFAULT_CPA_BASE_URL = "http://127.0.0.1:8317";
const DISCOVERY_TIMEOUT_MS = 10_000;
const STARTUP_DISCOVERY_TIMEOUT_MS = 2_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface CcrModelEntry {
	id: string;
	owned_by?: string;
	display_name?: string;
	context_window?: number;
	max_context_window?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	supported_reasoning_levels?: unknown;
	reasoning_required?: boolean;
}

// Pi levels CCR can address by name. CCR advertises its own level vocabulary,
// so a derived map only uses names both sides recognize.
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface CcrModelList {
	data?: unknown;
}

interface CpaModelEntry {
	slug: string;
	context_window?: number;
	max_context_window?: number;
	max_input_tokens?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
}

interface CpaModelList {
	models?: unknown;
}

function buildBuiltinCatalog(): Map<string, Model<Api>> {
	const catalog = new Map<string, Model<Api>>();

	// Provider order is significant: canonical providers come before alternate
	// routes, so duplicate model IDs keep the canonical model metadata.
	for (const provider of builtinProviders()) {
		for (const model of provider.getModels()) {
			if (!catalog.has(model.id)) catalog.set(model.id, model);
		}
	}

	return catalog;
}

export function upstreamModelId(entry: CcrModelEntry): string {
	const ownerPrefix = entry.owned_by ? `${entry.owned_by}/` : "";
	if (ownerPrefix && entry.id.startsWith(ownerPrefix)) {
		return entry.id.slice(ownerPrefix.length);
	}

	// CCR model IDs are normally Provider/model. Keep IDs without a route
	// prefix untouched so virtual/router models still work.
	const separator = entry.id.indexOf("/");
	return separator === -1 ? entry.id : entry.id.slice(separator + 1);
}

export function toCcrModel(
	entry: CcrModelEntry,
	baseUrl: string,
	catalog: Map<string, Model<Api>>,
): Model<Api> {
	const upstreamId = upstreamModelId(entry);
	const known = catalog.get(upstreamId);
	const displayName = entry.display_name ?? known?.name ?? upstreamId;
	const owner = entry.owned_by ? `${entry.owned_by} / ` : "";
	// CCR advertises the effective per-route budget, already reduced by the
	// provider's effectiveContextWindowPercent. That is route truth, so it wins
	// over Pi's generic catalog guess for the same model id.
	const advertisedContextWindow = ccrModelContextWindow(entry);
	const advertisedMaxTokens = positiveNumber(entry.max_output_tokens);
	const reasoningLevels = ccrModelReasoningLevels(entry);
	const thinkingLevelMap = reasoningLevelMap(reasoningLevels, known);

	return {
		type: "chat",
		id: entry.id,
		name: `${owner}${displayName}`,
		api: "openai-responses",
		provider: PROVIDER_ID,
		baseUrl,
		reasoning:
			reasoningLevels.some((level) => level !== "off") || entry.reasoning_required === true
				? true
				: (known?.reasoning ?? false),
		thinkingLevelMap,
		input: known?.input ?? ["text"],
		inputLimits: known?.inputLimits,
		cost: known?.cost ?? { ...ZERO_COST },
		contextWindow: advertisedContextWindow ?? known?.contextWindow ?? 128_000,
		maxTokens: advertisedMaxTokens ?? known?.maxTokens ?? 16_384,

		// Deliberately do not copy compat, headers, sampling parameters, or
		// prompt-cache settings from the upstream provider. Those describe the
		// upstream transport, while Pi talks to CCR through OpenAI Responses.
	};
}

export function parseModelList(payload: CcrModelList): CcrModelEntry[] {
	if (!Array.isArray(payload.data)) {
		throw new Error("CCR model discovery returned an invalid response: missing data array");
	}

	const entries = new Map<string, CcrModelEntry>();
	for (const value of payload.data) {
		if (typeof value !== "object" || value === null) continue;
		const candidate = value as Record<string, unknown>;
		if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;

		const entry: CcrModelEntry = {
			id: candidate.id,
			owned_by: typeof candidate.owned_by === "string" ? candidate.owned_by : undefined,
			display_name: typeof candidate.display_name === "string" ? candidate.display_name : undefined,
			context_window: positiveNumber(candidate.context_window),
			max_context_window: positiveNumber(candidate.max_context_window),
			max_input_tokens: positiveNumber(candidate.max_input_tokens),
			max_output_tokens: positiveNumber(candidate.max_output_tokens ?? candidate.max_tokens),
			supported_reasoning_levels: Array.isArray(candidate.supported_reasoning_levels)
				? candidate.supported_reasoning_levels
				: undefined,
			reasoning_required:
				typeof candidate.reasoning_required === "boolean" ? candidate.reasoning_required : undefined,
		};
		entries.set(entry.id, entry);
	}

	return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function storedModels(context: RefreshModelsContext): Model<Api>[] {
	return (
		context.stored?.models.filter(
			(model): model is Model<Api> =>
				model.provider === PROVIDER_ID && model.api === "openai-responses" && isModelType(model, "chat"),
		) ?? []
	);
}

async function fetchCcrModels(
	baseUrl: string,
	apiKey: string | undefined,
	signal: AbortSignal,
	catalog: Map<string, Model<Api>>,
): Promise<Model<Api>[]> {
	const headers: Record<string, string> = { "x-ccr-client": "pi" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await fetch(`${baseUrl}/models`, { headers, signal });
	if (!response.ok) {
		throw new Error(`CCR model discovery failed with HTTP ${response.status}`);
	}

	const entries = parseModelList((await response.json()) as CcrModelList);
	signal.throwIfAborted();
	const models = entries.map((entry) => toCcrModel(entry, baseUrl, catalog));
	return enrichWithCpaMetadata(models, signal);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

export function ccrModelContextWindow(entry: CcrModelEntry): number | undefined {
	// context_window is the route budget; the wider max_context_window is only a
	// fallback, matching how Pi budgets one number per model.
	return (
		positiveNumber(entry.context_window) ??
		positiveNumber(entry.max_input_tokens) ??
		positiveNumber(entry.max_context_window)
	);
}

export function ccrModelReasoningLevels(entry: CcrModelEntry): string[] {
	if (!Array.isArray(entry.supported_reasoning_levels)) return [];

	const levels: string[] = [];
	for (const item of entry.supported_reasoning_levels) {
		const effort =
			typeof item === "string"
				? item
				: item && typeof item === "object"
					? (item as { effort?: unknown }).effort
					: undefined;
			if (typeof effort === "string" && effort.trim()) levels.push(effort.trim());
	}
	return levels;
}

function reasoningLevelMap(
	levels: string[],
	known: Model<Api> | undefined,
): Model<Api>["thinkingLevelMap"] | undefined {
	// CCR may advertise a vocabulary Pi does not address by name. Keep whatever
	// Pi already knows instead of guessing, so no level silently disappears.
	if (levels.length === 0 || !levels.some((level) => PI_THINKING_LEVELS.includes(level))) {
		return known?.thinkingLevelMap;
	}

	const catalog = known?.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
	const map: Record<string, string | null> = {};
	for (const level of PI_THINKING_LEVELS) {
		const mapped = catalog?.[level];
		if (mapped === null) {
			map[level] = null;
		} else if (level === "off") {
			// Omitting "off" only means the route never lists a no-thinking effort;
		// it does not mean thinking cannot be switched off.
			map[level] = mapped ?? "off";
		} else {
			map[level] = levels.includes(level) ? (mapped ?? level) : null;
		}
	}
	return map as Model<Api>["thinkingLevelMap"];
}

export function parseCpaModelList(payload: CpaModelList): Map<string, CpaModelEntry> {
	if (!Array.isArray(payload.models)) {
		throw new Error("CPA model discovery returned an invalid response: missing models array");
	}

	const entries = new Map<string, CpaModelEntry>();
	for (const value of payload.models) {
		if (typeof value !== "object" || value === null) continue;
		const candidate = value as Record<string, unknown>;
		if (typeof candidate.slug !== "string" || !candidate.slug.trim()) continue;
		entries.set(candidate.slug, {
			slug: candidate.slug,
			context_window: positiveNumber(candidate.context_window),
			max_context_window: positiveNumber(candidate.max_context_window),
			max_input_tokens: positiveNumber(candidate.max_input_tokens),
			max_tokens: positiveNumber(candidate.max_tokens),
			max_completion_tokens: positiveNumber(candidate.max_completion_tokens),
		});
	}
	return entries;
}

export async function enrichWithCpaMetadata(models: Model<Api>[], signal: AbortSignal): Promise<Model<Api>[]> {
	const apiKey = process.env.CPA_API_KEY?.trim();
	if (!apiKey || !models.some((model) => model.id.toLowerCase().startsWith("cpa/"))) return models;

	const configuredBaseUrl = (process.env.CPA_BASE_URL?.trim() || DEFAULT_CPA_BASE_URL).replace(/\/+$/, "");
	const baseUrl = configuredBaseUrl.endsWith("/v1") ? configuredBaseUrl : `${configuredBaseUrl}/v1`;

	try {
		const response = await fetch(`${baseUrl}/models?client_version=0.0.0`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!response.ok) throw new Error(`CPA model discovery failed with HTTP ${response.status}`);

		const catalog = parseCpaModelList((await response.json()) as CpaModelList);
		signal.throwIfAborted();

		return models.map((model) => {
			if (!model.id.toLowerCase().startsWith("cpa/")) return model;
			const upstreamId = upstreamModelId({ id: model.id, owned_by: "CPA" });
			const cpa = catalog.get(upstreamId);
			if (!cpa) return model;

			return {
				...model,
				// CPA's context_window describes the effective route budget. Only
				// fall back to the larger max_context_window when it is absent.
				contextWindow:
					cpa.context_window ?? cpa.max_input_tokens ?? cpa.max_context_window ?? model.contextWindow,
				maxTokens: cpa.max_tokens ?? cpa.max_completion_tokens ?? model.maxTokens,
			};
		});
	} catch (error) {
		if (signal.aborted) throw error;
		// CPA enrichment is optional. Keep CCR/Pi catalog metadata when the
		// direct CPA metadata endpoint is unavailable.
		return models;
	}
}

async function discoverModels(
	context: RefreshModelsContext,
	catalog: Map<string, Model<Api>>,
	currentModels: Model<Api>[],
) {
	const cached = storedModels(context);
	// Prefer models fetched during this extension load over an older persisted
	// snapshot. If startup discovery was offline, currentModels is empty and
	// the persisted snapshot remains the fallback.
	const fallback = currentModels.length > 0 ? currentModels : cached;
	if (!context.allowNetwork) return fallback;

	const baseUrl = (context.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const signal = AbortSignal.any([context.signal, timeout]);
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;

	try {
		const models = await fetchCcrModels(baseUrl, apiKey, signal, catalog);
		context.signal.throwIfAborted();

		// A snapshot makes the last successful catalog available offline. This
		// contains model metadata only; API keys are never persisted here.
		await context.publish({ persist: { models, checkedAt: Date.now() } });
		return models;
	} catch (error) {
		if (fallback.length > 0 && !context.signal.aborted) return fallback;
		throw error;
	}
}

async function discoverModelsAtStartup(catalog: Map<string, Model<Api>>): Promise<Model<Api>[]> {
	const apiKey = process.env.CCR_API_KEY?.trim();
	if (!apiKey) return [];

	try {
		// Initial models make --provider/--model and --list-models work before
		// the first interactive refresh. A short timeout avoids stalling startup
		// when CCR is stopped; /model can retry with the normal refresh timeout.
		const signal = AbortSignal.timeout(STARTUP_DISCOVERY_TIMEOUT_MS);
		return await fetchCcrModels(DEFAULT_BASE_URL, apiKey, signal, catalog);
	} catch {
		return [];
	}
}

export default async function (pi: ExtensionAPI) {
	const catalog = buildBuiltinCatalog();
	const initialModels = await discoverModelsAtStartup(catalog);
	let currentModels = initialModels;

	pi.registerProvider(PROVIDER_ID, {
		name: "Claude Code Router",
		baseUrl: DEFAULT_BASE_URL,
		apiKey: "$CCR_API_KEY",
		authHeader: true,
		api: "openai-responses",
		headers: { "x-ccr-client": "pi" },
		models: initialModels,
		refreshModels: async (context) => {
			currentModels = await discoverModels(context, catalog, currentModels);
			return currentModels;
		},
	});
}
