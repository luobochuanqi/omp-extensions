// Self-check: drives the extension factory with a mock ExtensionAPI and
// asserts capture, response pairing, buffer eviction, and /wire dispatch.
// Run: bun selfcheck.ts
import assert from "node:assert";
import { unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import wiretap from "./index";
import { WIRETAP_MESSAGE_TYPE, type WiretapDetails } from "./render";

interface Sent {
	payload: { customType?: string; content?: string; details?: unknown };
	options?: { triggerTurn?: boolean };
}

function makePi() {
	const handlers = new Map<string, ((event: never, ctx: never) => unknown)[]>();
	const sent: Sent[] = [];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: never) => Promise<void> }>();
	const renderers = new Map<string, unknown>();
	const statuses: [string, string | undefined][] = [];
	const logs: string[] = [];
	const pi = {
		setLabel: () => {},
		registerMessageRenderer: (type: string, r: unknown) => renderers.set(type, r),
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: never) => Promise<void> }) =>
			commands.set(name, def),
		sendMessage: (payload: Sent["payload"], options?: Sent["options"]) => sent.push({ payload, options }),
		logger: {
			error: (msg: string) => logs.push(msg),
			warn: () => {},
			info: () => {},
			debug: () => {},
		},
	};
	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		for (const h of handlers.get(event) ?? []) await (h as (e: unknown, c: unknown) => unknown)(payload, ctx);
	};
	return { pi, sent, commands, renderers, statuses, logs, emit };
}

const model = {
	id: "claude-sonnet-4-5",
	requestModelId: undefined,
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1/messages",
};

function makeCtx(cwd: string) {
	return {
		model,
		hasUI: false,
		cwd,
		ui: { setStatus: () => {}, notify: () => {} },
	};
}

async function main() {
	const harness = makePi();
	wiretap(harness.pi as unknown as ExtensionAPI);

	assert.ok(harness.renderers.has(WIRETAP_MESSAGE_TYPE), "renderer registered");
	const wire = harness.commands.get("wire");
	assert.ok(wire, "/wire command registered");

	const ctx = makeCtx(process.cwd());

	// Two request/response pairs.
	await harness.emit("before_provider_request", { payload: { model: model.id, messages: [{ role: "user", content: "hi" }] } }, ctx);
	await harness.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: { "content-type": "text/event-stream" }, requestId: "req_1" }, ctx);
	await harness.emit("before_provider_request", { payload: { model: model.id, n: 42 } }, ctx);

	// List view: request #2 still pending.
	harness.sent.length = 0;
	await wire!.handler("", ctx as never);
	assert.equal(harness.sent.length, 1);
	const list = harness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(list.kind, "list");
	assert.equal(list.requests.length, 2);
	assert.equal(list.requests[0]!.status, 200);
	assert.equal(list.requests[0]!.requestId, "req_1");
	assert.equal(list.requests[0]!.durationMs !== undefined, true);
	assert.equal(list.requests[1]!.status, undefined, "second request pending");
	assert.equal(harness.sent[0]!.options?.triggerTurn, false, "views never trigger a turn");
	assert.ok(harness.sent[0]!.payload.content!.startsWith("[wiretap]"), "short LLM-visible summary");

	// Detail view carries the raw body and response headers.
	harness.sent.length = 0;
	await wire!.handler("1", ctx as never);
	const detail = harness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "detail" }>;
	assert.equal(detail.kind, "detail");
	assert.deepEqual(detail.headers, [["content-type", "text/event-stream"]]);
	assert.deepEqual(JSON.parse(detail.body), { model: model.id, messages: [{ role: "user", content: "hi" }] });
	assert.equal(detail.notes.length, 0);

	// Pending detail warns about the unpaired response.
	harness.sent.length = 0;
	await wire!.handler("2", ctx as never);
	const pending = harness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "detail" }>;
	assert.ok(pending.notes.some(n => n.includes("no response paired")), "pending note present");

	// Unknown seq → warning note.
	harness.sent.length = 0;
	await wire!.handler("99", ctx as never);
	const missing = harness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "note" }>;
	assert.equal(missing.kind, "note");
	assert.equal(missing.tone, "warning");

	// Dump writes the exact pretty-printed body.
	harness.sent.length = 0;
	const dumpPath = `selfcheck-dump-${process.pid}.json`;
	await wire!.handler(`dump 1 ${dumpPath}`, ctx as never);
	const dumped = JSON.parse(await readFile(dumpPath, "utf8"));
	assert.deepEqual(dumped, { model: model.id, messages: [{ role: "user", content: "hi" }] });
	unlinkSync(dumpPath);
	assert.ok((harness.sent[0]!.payload.details as { kind: string }).kind === "note");

	// Payload that refuses to stringify must not throw or kill the request.
	const circular: Record<string, unknown> = { a: 1 };
	circular.self = circular;
	await harness.emit("before_provider_request", { payload: circular }, ctx);
	assert.equal(harness.logs.length, 0, "stringify fallback handled in-line");

	// Eviction: exceed MAX_CAPTURES (32) — buffer stays bounded, seq keeps climbing.
	for (let i = 0; i < 40; i++) {
		await harness.emit("before_provider_request", { payload: { i, pad: "x".repeat(1000) } }, ctx);
		await harness.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	}
	harness.sent.length = 0;
	await wire!.handler("", ctx as never);
	const bounded = harness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.ok(bounded.requests.length <= 32, `buffer bounded, got ${bounded.requests.length}`);
	assert.ok(bounded.dropped > 0, "evictions counted");
	assert.ok(bounded.requests.every((r, i, all) => i === 0 || r.seq > all[i - 1]!.seq), "seq monotonic");

	// Clear empties the buffer.
	harness.sent.length = 0;
	await wire!.handler("clear", ctx as never);
	await wire!.handler("", ctx as never);
	const cleared = harness.sent[harness.sent.length - 1]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(cleared.requests.length, 0);

	// Bad subcommand → warning note, no throw.
	harness.sent.length = 0;
	await wire!.handler("bogus", ctx as never);
	assert.equal((harness.sent[0]!.payload.details as { tone?: string }).tone, "warning");

	console.log("selfcheck: all assertions passed");
}

await main();
