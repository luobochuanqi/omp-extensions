// Self-check: drives the extension factory with a mock ExtensionAPI and
// asserts capture, response pairing, delta storage, persistence across a
// simulated resume, and /wire dispatch.
// Run: bun selfcheck.ts
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface Session {
	sid: string;
	dir: string | null;
}

function makeCtx(cwd: string, session: Session) {
	return {
		model,
		hasUI: false,
		cwd,
		ui: { setStatus: () => {}, notify: () => {} },
		sessionManager: {
			getSessionId: () => session.sid,
			getArtifactsDir: () => session.dir,
		},
	};
}

async function main() {
	const storeDir = mkdtempSync(join(tmpdir(), "wiretap-selfcheck-"));
	const storePath = join(storeDir, "wiretap", "selfcheck-session.ndjson");
	const session: Session = { sid: "selfcheck-session", dir: storeDir };
	const harness = makePi();
	wiretap(harness.pi as unknown as ExtensionAPI);

	assert.ok(harness.renderers.has(WIRETAP_MESSAGE_TYPE), "renderer registered");
	const wire = harness.commands.get("wire");
	assert.ok(wire, "/wire command registered");

	const ctx = makeCtx(process.cwd(), session);

	// Two request/response pairs. payload2 appends to payload1, the common case
	// on the wire — its stored record must be a delta.
	let naiveBytes = 0;
	const track = (payload: unknown) => {
		naiveBytes += JSON.stringify(payload, null, 2).length;
		return payload;
	};
	const payload1 = track({
		model: model.id,
		system: "ctx ".repeat(100),
		messages: [{ role: "user", content: "hi" }],
	});
	const payload2 = track({
		model: model.id,
		system: "ctx ".repeat(100),
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		],
	});

	await harness.emit("before_provider_request", { payload: payload1 }, ctx);
	await harness.emit(
		"after_provider_response",
		{ type: "after_provider_response", status: 200, headers: { "content-type": "text/event-stream" }, requestId: "req_1" },
		ctx,
	);
	await harness.emit("before_provider_request", { payload: payload2 }, ctx);

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
	assert.deepEqual(JSON.parse(detail.body), payload1);
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
	const dumpPath = join(storeDir, "dump.json");
	await wire!.handler(`dump 1 ${dumpPath}`, ctx as never);
	const dumped = JSON.parse(await readFile(dumpPath, "utf8"));
	assert.deepEqual(dumped, payload1);
	assert.equal((harness.sent[0]!.payload.details as { kind: string }).kind, "note");

	// Payload that refuses to stringify must not throw or kill the request.
	const circular: Record<string, unknown> = { a: 1 };
	circular.self = circular;
	await harness.emit("before_provider_request", { payload: circular }, ctx);
	naiveBytes += String(circular).length;
	assert.equal(harness.logs.length, 0, "stringify fallback handled in-line");

	// Storage format: first record full, second record a delta against it.
	const records = readFileSync(storePath, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { t: string; seq?: number; body?: string; d?: unknown; status?: number; headers?: Record<string, string> });
	const rec1 = records.find(r => r.t === "req" && r.seq === 1)!;
	const rec2 = records.find(r => r.t === "req" && r.seq === 2)!;
	assert.ok(rec1.body, "first record stores a full body");
	assert.ok(rec2.d !== undefined && rec2.body === undefined, "appended-message record stores a delta");
	const res1 = records.find(r => r.t === "res" && r.seq === 1)!;
	assert.equal(res1.status, 200);
	assert.equal(res1.headers!["content-type"], "text/event-stream");

	// A fresh extension instance (as after /resume) reloads the same store.
	const resumed = makePi();
	wiretap(resumed.pi as unknown as ExtensionAPI);
	resumed.sent.length = 0;
	await resumed.commands.get("wire")!.handler("", ctx as never);
	const reloaded = resumed.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(reloaded.requests.length, 3, "all records survive resume");
	assert.equal(reloaded.requests[0]!.status, 200);
	assert.equal(reloaded.requests[0]!.requestId, "req_1");
	assert.equal(reloaded.requests[1]!.status, undefined, "pending state survives");
	assert.equal(reloaded.storedBytes, statSync(storePath).size);

	// Delta bodies reconstruct byte-identically after reload.
	resumed.sent.length = 0;
	await resumed.commands.get("wire")!.handler("2", ctx as never);
	const reloadedDetail = resumed.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "detail" }>;
	assert.deepEqual(JSON.parse(reloadedDetail.body), payload2, "delta reconstructs the appended body");
	resumed.sent.length = 0;
	await resumed.commands.get("wire")!.handler("1", ctx as never);
	const reloadedFull = resumed.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "detail" }>;
	assert.deepEqual(JSON.parse(reloadedFull.body), payload1, "full record survives resume");
	assert.deepEqual(reloadedFull.headers, [["content-type", "text/event-stream"]], "response headers survive resume");

	// No eviction: every record stays addressable, seq stays monotonic.
	for (let i = 0; i < 40; i++) {
		const payload = track({ i, pad: "x".repeat(1000) });
		await harness.emit("before_provider_request", { payload }, ctx);
		await harness.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	}
	harness.sent.length = 0;
	await wire!.handler("", ctx as never);
	const stored = harness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(stored.requests.length, 43, "no records dropped");
	assert.ok(stored.requests.every((r, i, all) => i === 0 || r.seq > all[i - 1]!.seq), "seq monotonic");
	assert.ok((stored.storedBytes ?? 0) > 0, "store size reported");

	// Full anchor on the 32nd record; deltas keep total storage well below naive.
	const anchor = readFileSync(storePath, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l) as { t: string; seq?: number; body?: string })
		.find(r => r.t === "req" && r.seq === 32)!;
	assert.ok(anchor.body, "every 32nd record is a full anchor");
	const storedBytes = statSync(storePath).size;
	assert.ok(storedBytes < naiveBytes, `deltas save space: stored ${storedBytes} vs naive bodies ${naiveBytes}`);

	// Clear truncates the store; a later resume sees an empty session.
	harness.sent.length = 0;
	await wire!.handler("clear", ctx as never);
	assert.equal(readFileSync(storePath, "utf8"), "", "clear truncates the store file");
	await wire!.handler("", ctx as never);
	const cleared = harness.sent[harness.sent.length - 1]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(cleared.requests.length, 0);

	const afterClear = makePi();
	wiretap(afterClear.pi as unknown as ExtensionAPI);
	await afterClear.commands.get("wire")!.handler("", ctx as never);
	const emptyReload = afterClear.sent[afterClear.sent.length - 1]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(emptyReload.requests.length, 0, "cleared store stays empty across resume");

	// Sessions sharing one artifacts dir (parent + subagent) own separate files.
	const subSession: Session = { sid: "subagent-session", dir: storeDir };
	const subCtx = makeCtx(process.cwd(), subSession);
	const subHarness = makePi();
	wiretap(subHarness.pi as unknown as ExtensionAPI);
	await subHarness.emit("before_provider_request", { payload: payload1 }, subCtx);
	assert.ok(
		existsSync(join(storeDir, "wiretap", "subagent-session.ndjson")),
		"subagent writes its own store file",
	);
	assert.equal(readFileSync(storePath, "utf8"), "", "parent store untouched by the subagent's records");
	subHarness.sent.length = 0;
	await subHarness.commands.get("wire")!.handler("", subCtx as never);
	const subList = subHarness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "list" }>;
	assert.equal(subList.requests.length, 1, "subagent sees its own capture");

	// A session with no store (--no-session) serves bodies from memory instead.
	const memSession: Session = { sid: "storeless-session", dir: null };
	const memCtx = makeCtx(process.cwd(), memSession);
	const memHarness = makePi();
	wiretap(memHarness.pi as unknown as ExtensionAPI);
	await memHarness.emit("before_provider_request", { payload: payload1 }, memCtx);
	await memHarness.emit(
		"after_provider_response",
		{ type: "after_provider_response", status: 200, headers: {}, requestId: null },
		memCtx,
	);
	memHarness.sent.length = 0;
	await memHarness.commands.get("wire")!.handler("1", memCtx as never);
	const memDetail = memHarness.sent[0]!.payload.details as Extract<WiretapDetails, { kind: "detail" }>;
	assert.equal(memDetail.kind, "detail");
	assert.deepEqual(JSON.parse(memDetail.body), payload1, "storeless session keeps bodies viewable");
	assert.equal(memDetail.request.status, 200);

	// Bad subcommand → warning note, no throw.
	harness.sent.length = 0;
	await wire!.handler("bogus", ctx as never);
	assert.equal((harness.sent[0]!.payload.details as { tone?: string }).tone, "warning");

	assert.equal(harness.logs.length, 0, "no store errors logged");
	rmSync(storeDir, { recursive: true, force: true });
	console.log("selfcheck: all assertions passed");
}

await main();
