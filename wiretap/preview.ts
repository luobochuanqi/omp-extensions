// Dev harness: renders sample wiretap views against the real dark theme.
// Run: bun preview.ts [width]
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui";
import { renderWiretap, type WiretapDetails } from "./render";

ensureThemeSync();

const width = Number(process.argv[2] ?? 110);
const now = Date.now();

const longString = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(40)}`;
const sampleBody = JSON.stringify(
	{
		model: "claude-sonnet-4-5",
		max_tokens: 64000,
		stream: true,
		thinking: { type: "enabled", budget_tokens: 32000 },
		system: [
			{
				type: "text",
				text: "You are a helpful, trusted assistant working in Oh My Pi coding harness.\n# Engineering\n- Correctness first; then maintainability 6 months out.",
				cache_control: { type: "ephemeral" },
			},
		],
		messages: [
			{ role: "user", content: "做一个omp的extension，用途：展示原始网络请求信息。" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Let me explore the workspace structure first..." },
					{ type: "toolCall", id: "toolu_01A2B3", name: "read", arguments: { path: ".", i: "Exploring workspace" } },
				],
			},
			{
				role: "user",
				content: [
					{ type: "toolResult", toolCallId: "toolu_01A2B3", content: [{ type: "text", text: "(empty directory)" }] },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: longString } },
				],
			},
		],
		tools: [
			{ name: "read", description: "Read files, directories, archives, SQLite, images, documents...", input_schema: { type: "object", properties: { path: { type: "string" }, i: { type: "string" } }, required: ["path", "i"] } },
			{ name: "bash", description: "Runs commands in a persistent shell.", input_schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } },
		],
		metadata: { user_id: "user_luobo_acct_01" },
	},
	null,
	2,
);

function req(seq: number, ageSec: number, over: Partial<{ status: number; durationMs: number; provider: string; modelId: string; modelName: string; bytes: number; requestId: string | null }> = {}) {
	return {
		seq,
		at: now - ageSec * 1000,
		provider: over.provider ?? "anthropic",
		api: "anthropic-messages",
		modelId: over.modelId ?? "claude-sonnet-4-5",
		modelName: over.modelName ?? "Claude Sonnet 4.5",
		baseUrl: "https://api.anthropic.com/v1/messages",
		bytes: over.bytes ?? 184_300 + seq * 2048,
		status: over.status,
		durationMs: over.durationMs,
		requestId: over.requestId,
	};
}

const views: [string, WiretapDetails][] = [
	[
		"LIST",
		{
			kind: "list",
			dropped: 2,
			bufferedBytes: 4_812_300,
			requests: [
				req(3, 190, { status: 200, durationMs: 1240, requestId: "req_01JZ3" }),
				req(4, 145, { status: 200, durationMs: 843 }),
				req(5, 98, { status: 429, durationMs: 201 }),
				req(6, 64, { status: 200, durationMs: 1105 }),
				req(7, 30, { status: 500, durationMs: 30_200, provider: "openai", modelId: "gpt-5.2-codex", modelName: "GPT-5.2 Codex", bytes: 402_811 }),
				req(8, 12, { status: 200, durationMs: 2410 }),
				req(9, 2, {}),
			],
		},
	],
	[
		"DETAIL",
		{
			kind: "detail",
			request: req(8, 12, { status: 200, durationMs: 2410, requestId: "req_01JZ9QW8PX" }),
			headers: [
				["content-type", "text/event-stream; charset=utf-8"],
				["anthropic-ratelimit-requests-remaining", "1842"],
				["request-id", "req_01JZ9QW8PX"],
				["cf-cache-status", "DYNAMIC"],
			],
			body: sampleBody,
			notes: ["showing 600 of 812 lines — /wire dump 8 exports the full body"],
		},
	],
	["LIST (empty)", { kind: "list", requests: [], dropped: 0, bufferedBytes: 0 }],
	["NOTE (error)", { kind: "note", text: "wiretap command failed: boom", tone: "error" }],
];

for (const [title, details] of views) {
	console.log(`\n${"=".repeat(width)}\n${title} @ ${width} cols (expanded=false)\n${"=".repeat(width)}`);
	const component = renderWiretap({ details }, { expanded: false }, theme);
	if (!component) throw new Error(`renderer rejected ${title}`);
	for (const line of component.render(width)) console.log(line);
}

const detailExpanded = views[1][1];
console.log(`\n${"=".repeat(width)}\nDETAIL @ ${width} cols (expanded=true, lines 30-100)\n${"=".repeat(width)}`);
const expandedComp = renderWiretap({ details: detailExpanded }, { expanded: true }, theme)!;
for (const line of expandedComp.render(width).slice(30, 100)) console.log(line);
