import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	enrichWithCpaMetadata,
	parseCpaModelList,
	parseModelList,
	toCcrModel,
	upstreamModelId,
} from "../src/index.ts";

const CCR_BASE_URL = "http://127.0.0.1:3456/v1";

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		type: "chat",
		id,
		name: id,
		api: "openai-responses",
		provider: "ccr",
		baseUrl: CCR_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

function withCpaEnv(apiKey: string | undefined, run: () => Promise<void>): Promise<void> {
	const previousKey = process.env.CPA_API_KEY;
	const previousUrl = process.env.CPA_BASE_URL;
	if (apiKey === undefined) delete process.env.CPA_API_KEY;
	else process.env.CPA_API_KEY = apiKey;
	process.env.CPA_BASE_URL = "http://cpa.test";

	return run().finally(() => {
		if (previousKey === undefined) delete process.env.CPA_API_KEY;
		else process.env.CPA_API_KEY = previousKey;
		if (previousUrl === undefined) delete process.env.CPA_BASE_URL;
		else process.env.CPA_BASE_URL = previousUrl;
	});
}

test("upstreamModelId removes the CCR route owner only", () => {
	assert.equal(upstreamModelId({ id: "CPA/claude-sonnet-5-5", owned_by: "CPA" }), "claude-sonnet-5-5");
	assert.equal(upstreamModelId({ id: "kilo/anthropic/claude-sonnet-5.5", owned_by: "kilo" }), "anthropic/claude-sonnet-5.5");
	assert.equal(upstreamModelId({ id: "virtual-model", owned_by: "router" }), "virtual-model");
});

test("parseModelList validates, deduplicates, and sorts CCR models", () => {
	const models = parseModelList({
		data: [
			{ id: "CPA/z", owned_by: "CPA" },
			{ id: "CPA/a", owned_by: "CPA", display_name: "A" },
			{ id: "CPA/z", owned_by: "CPA" },
			{ id: "" },
			null,
		],
	});
	assert.deepEqual(models.map((entry) => entry.id), ["CPA/a", "CPA/z"]);
	assert.equal(models[0]?.display_name, "A");
	assert.throws(() => parseModelList({}), /missing data array/);
});

test("toCcrModel copies model capabilities but not upstream transport config", () => {
	const known = model("claude-test", {
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: { supportsTemperature: false } as Model<Api>["compat"],
	});
	const result = toCcrModel(
		{ id: "CPA/claude-test", owned_by: "CPA" },
		CCR_BASE_URL,
		new Map([[known.id, known]]),
	);

	assert.equal(result.provider, "ccr");
	assert.equal(result.api, "openai-responses");
	assert.equal(result.baseUrl, CCR_BASE_URL);
	assert.equal(result.reasoning, true);
	assert.deepEqual(result.input, ["text", "image"]);
	assert.equal(result.contextWindow, 1_000_000);
	assert.equal(result.maxTokens, 128_000);
	assert.equal(result.compat, undefined);
});

test("toCcrModel uses conservative metadata for unknown models", () => {
	const result = toCcrModel({ id: "CPA/unknown", owned_by: "CPA" }, CCR_BASE_URL, new Map());
	assert.equal(result.contextWindow, 128_000);
	assert.equal(result.maxTokens, 16_384);
	assert.equal(result.reasoning, false);
	assert.deepEqual(result.input, ["text"]);
});

test("toCcrModel prefers the context window CCR advertises for the route", () => {
	const known = model("Qwen3.8-Flash", { contextWindow: 1_000_000, maxTokens: 131_072 });
	const result = toCcrModel(
		{
			id: "oMLX-CF/Qwen3.8-Flash",
			owned_by: "oMLX-CF",
			context_window: 262_144,
			max_context_window: 1_048_576,
			max_input_tokens: 262_144,
		},
		CCR_BASE_URL,
		new Map([[known.id, known]]),
	);

	assert.equal(result.contextWindow, 262_144);
	assert.equal(result.maxTokens, 131_072);
});

test("advertised limits fall back through max_input_tokens then max_context_window", () => {
	const byInput = toCcrModel({ id: "a/x", owned_by: "a", max_input_tokens: 272_000 }, CCR_BASE_URL, new Map());
	const byMax = toCcrModel({ id: "a/y", owned_by: "a", max_context_window: 872_000 }, CCR_BASE_URL, new Map());
	const invalid = toCcrModel({ id: "a/z", owned_by: "a", context_window: 0 }, CCR_BASE_URL, new Map());

	assert.equal(byInput.contextWindow, 272_000);
	assert.equal(byMax.contextWindow, 872_000);
	assert.equal(invalid.contextWindow, 128_000);
});

test("CCR reasoning levels become a Pi thinking map", () => {
	const result = toCcrModel(
		{
			id: "oMLX-CF/Qwen3.8-Flash",
			owned_by: "oMLX-CF",
			supported_reasoning_levels: ["off", "low", "medium", { description: "Extra high", effort: "xhigh" }],
		},
		CCR_BASE_URL,
		new Map(),
	);

	assert.equal(result.reasoning, true);
	assert.equal(result.thinkingLevelMap?.medium, "medium");
	assert.equal(result.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(result.thinkingLevelMap?.high, null);
	assert.equal(result.thinkingLevelMap?.max, null);
});

test("CCR levels narrow Pi catalog levels without dropping thinking off", () => {
	const known = model("claude-test", {
		reasoning: true,
		thinkingLevelMap: { off: "off", low: "low", medium: "medium", max: null } as Model<Api>["thinkingLevelMap"],
	});
	const result = toCcrModel(
		{ id: "CPA/claude-test", owned_by: "CPA", supported_reasoning_levels: ["low", "medium", "xhigh"] },
		CCR_BASE_URL,
		new Map([[known.id, known]]),
	);

	assert.equal(result.thinkingLevelMap?.off, "off");
	assert.equal(result.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(result.thinkingLevelMap?.high, null);
	assert.equal(result.thinkingLevelMap?.max, null);
});

test("unrecognized reasoning vocabulary keeps catalog levels and marks reasoning off-only", () => {
	const unknownVocabulary = toCcrModel(
		{ id: "a/x", owned_by: "a", supported_reasoning_levels: [{ effort: "turbo" }] },
		CCR_BASE_URL,
		new Map(),
	);
	const offOnly = toCcrModel({ id: "a/y", owned_by: "a", supported_reasoning_levels: ["off"] }, CCR_BASE_URL, new Map());
	const required = toCcrModel({ id: "a/z", owned_by: "a", reasoning_required: true }, CCR_BASE_URL, new Map());

	assert.equal(unknownVocabulary.thinkingLevelMap, undefined);
	assert.equal(offOnly.reasoning, false);
	assert.equal(required.reasoning, true);
});

test("parseCpaModelList reads positive numeric limits", () => {
	const catalog = parseCpaModelList({
		models: [
			{ slug: "gpt-test", context_window: 272_000, max_context_window: 872_000, max_tokens: 128_000 },
			{ slug: "invalid", context_window: -1 },
			{ id: "missing-slug" },
		],
	});
	assert.equal(catalog.get("gpt-test")?.context_window, 272_000);
	assert.equal(catalog.get("gpt-test")?.max_context_window, 872_000);
	assert.equal(catalog.get("invalid")?.context_window, undefined);
	assert.throws(() => parseCpaModelList({}), /missing models array/);
});

test("CPA enrichment prefers effective context_window and only changes CPA routes", async () => {
	await withCpaEnv("test-cpa-key", async () => {
		const originalFetch = globalThis.fetch;
		let requestedUrl = "";
		let authorization = "";
		globalThis.fetch = async (input, init) => {
			requestedUrl = String(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(
				JSON.stringify({
					models: [
						{ slug: "gpt-5.6-terra", context_window: 272_000, max_context_window: 872_000, max_tokens: 128_000 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			const terra = model("CPA/gpt-5.6-terra", { contextWindow: 1_050_000 });
			const kilo = model("kilo/openai/gpt-5.6-terra", { contextWindow: 1_050_000 });
			const result = await enrichWithCpaMetadata([terra, kilo], AbortSignal.timeout(1_000));

			assert.equal(result[0]?.contextWindow, 272_000);
			assert.equal(result[0]?.maxTokens, 128_000);
			assert.equal(result[1]?.contextWindow, 1_050_000);
			assert.equal(requestedUrl, "http://cpa.test/v1/models?client_version=0.0.0");
			assert.equal(authorization, "Bearer test-cpa-key");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("CPA enrichment falls back to max_context_window when context_window is absent", async () => {
	await withCpaEnv("test-cpa-key", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ models: [{ slug: "gpt-test", max_context_window: 872_000 }] }), {
				status: 200,
			});

		try {
			const result = await enrichWithCpaMetadata([model("CPA/gpt-test")], AbortSignal.timeout(1_000));
			assert.equal(result[0]?.contextWindow, 872_000);
			assert.equal(result[0]?.maxTokens, 16_384);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("CPA enrichment is skipped without CPA_API_KEY", async () => {
	await withCpaEnv(undefined, async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("fetch should not be called");
		};

		try {
			const models = [model("CPA/gpt-test")];
			const result = await enrichWithCpaMetadata(models, AbortSignal.timeout(1_000));
			assert.strictEqual(result, models);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("CPA metadata failures preserve CCR/Pi catalog models", async () => {
	await withCpaEnv("test-cpa-key", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

		try {
			const models = [model("CPA/gpt-test", { contextWindow: 1_050_000 })];
			const result = await enrichWithCpaMetadata(models, AbortSignal.timeout(1_000));
			assert.strictEqual(result, models);
			assert.equal(result[0]?.contextWindow, 1_050_000);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
