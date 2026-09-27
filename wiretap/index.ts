import { appendFileSync, mkdirSync, truncateSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	WIRETAP_MESSAGE_TYPE,
	humanBytes,
	renderWiretap,
	statusLabel,
	type WireRequest,
	type WiretapDetails,
} from "./render";

// Bodies larger than this are clipped before storing (display/dump budget).
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Body lines persisted into one detail view; the full body goes to /wire dump. */
const BODY_VIEW_LINES = 600;
/** Every Nth stored record repeats its full body so delta replay stays bounded. */
const FULL_ANCHOR_EVERY = 32;
// Sessions without a store (--no-session) keep bodies in memory under a fixed budget.
const MAX_MEMORY_BODIES = 32;
const MAX_MEMORY_BYTES = 24 * 1024 * 1024;

/** Changed run of a body relative to the previous one: shared prefix/suffix plus the changed middle. */
interface Delta {
	prefix: number;
	suffix: number;
	middle: string;
}

interface ReqLine {
	t: "req";
	seq: number;
	at: number;
	provider: string;
	api: string;
	modelId: string;
	modelName: string;
	baseUrl: string;
	bytes: number;
	clipped?: boolean;
	/** Full pretty body; present on anchors and on records with no reusable prefix. */
	body?: string;
	d?: Delta;
}

interface ResLine {
	t: "res";
	seq: number;
	at: number;
	status?: number;
	durationMs?: number;
	requestId?: string | null;
	headers?: Record<string, string>;
}

interface Capture {
	req: WireRequest;
	respondedAt?: number;
	headers?: Record<string, string>;
}

/** A reconstructed body plus its clip flag, as served to detail/dump views. */
interface StoredBody {
	body: string;
	clipped: boolean;
}

interface Store {
	path?: string;
	loading?: Promise<void>;
	dirReady?: boolean;
	captures: Capture[];
	nextSeq: number;
	storedBytes: number;
	/** Body of the last record actually written to `path`; delta base for the next one. */
	fileTail?: string;
	/** Bodies the file does not hold (storeless session or a failed write). */
	memBodies: Map<number, StoredBody>;
	memBytes: number;
}

// Line deltas. Consecutive provider payloads share nearly all bytes — the
// history is append-only most of the time — so a record only re-stores the
// region between the first and last changed character. Decoding is exact by
// construction: the prefix and suffix are equal in both strings by definition
// of the common prefix/suffix, so prefix + middle + suffix rebuilds the body.

function commonPrefix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

function commonSuffix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
	return i;
}

function encodeDelta(base: string, body: string): Delta | undefined {
	const p = commonPrefix(base, body);
	let s = commonSuffix(base, body);
	if (p + s > body.length) s = body.length - p;
	const m = body.slice(p, body.length - s);
	// JSON escaping can at most double `middle` inside the record line; require a clear win.
	return m.length * 2 < body.length ? { prefix: p, suffix: s, middle: m } : undefined;
}

function decodeDelta(base: string, d: Delta): string {
	return base.slice(0, d.prefix) + d.middle + base.slice(base.length - d.suffix);
}

/** Walk store text in order, reconstructing each request body against its predecessor. */
function* walkStore(text: string): Generator<{ line: ReqLine | ResLine; body: string | undefined }> {
	let cur: string | undefined;
	for (const raw of text.split("\n")) {
		if (!raw) continue;
		let line: ReqLine | ResLine;
		try {
			line = JSON.parse(raw);
		} catch {
			continue; // torn tail line after a crash; appends are atomic per line
		}
		if (line.t === "req") {
			if (typeof line.body === "string") cur = line.body;
			else if (line.d) cur = cur === undefined ? undefined : decodeDelta(cur, line.d);
			else cur = undefined;
			yield { line, body: cur };
		} else {
			yield { line, body: undefined };
		}
	}
}

function modelMeta(model: Model | undefined) {
	return {
		provider: model?.provider ?? "?",
		api: model?.api ?? "?",
		modelId: model?.requestModelId ?? model?.id ?? "?",
		modelName: model?.name ?? model?.id ?? "?",
		baseUrl: model?.baseUrl ?? "",
	};
}

export default function wiretap(pi: ExtensionAPI): void {
	pi.setLabel("Wiretap — raw provider request inspector");
	pi.registerMessageRenderer(WIRETAP_MESSAGE_TYPE, renderWiretap);

	// One store per session id: switching sessions must not lose the other's state.
	const stores = new Map<string, Store>();

	function newStore(): Store {
		return { captures: [], nextSeq: 1, storedBytes: 0, memBodies: new Map(), memBytes: 0 };
	}

	function readStore(path: string): Promise<{
		captures: Capture[];
		nextSeq: number;
		bytes: number;
		tail: string | undefined;
	}> {
		return (async () => {
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch (err) {
				storeAbsent(err);
				return { captures: [], nextSeq: 1, bytes: 0, tail: undefined };
			}
			const captures: Capture[] = [];
			const bySeq = new Map<number, Capture>();
			let maxSeq = 0;
			let tail: string | undefined;
			for (const { line, body } of walkStore(text)) {
				if (line.t === "req") {
					const capture: Capture = {
						req: {
							seq: line.seq,
							at: line.at,
							provider: line.provider,
							api: line.api,
							modelId: line.modelId,
							modelName: line.modelName,
							baseUrl: line.baseUrl,
							bytes: line.bytes,
						},
					};
					captures.push(capture);
					bySeq.set(line.seq, capture);
					if (line.seq > maxSeq) maxSeq = line.seq;
					tail = body;
				} else {
					const capture = bySeq.get(line.seq);
					if (!capture) continue;
					capture.respondedAt = line.at;
					if (line.status !== undefined) capture.req.status = line.status;
					if (line.durationMs !== undefined) capture.req.durationMs = line.durationMs;
					capture.req.requestId = line.requestId ?? null;
					if (line.headers) capture.headers = line.headers;
				}
			}
			return { captures, nextSeq: maxSeq + 1, bytes: Buffer.byteLength(text), tail };
		})();
	}

	/** Resolve the current session's store, loading its file once (per path). */
	function ensureStore(ctx: ExtensionContext): Promise<Store> {
		const sessionManager = ctx.sessionManager;
		const sid = sessionManager.getSessionId();
		let store = stores.get(sid);
		if (!store) {
			store = newStore();
			stores.set(sid, store);
		}
		const dir = sessionManager.getArtifactsDir();
		// One file per session id: a subagent adopts the parent's artifacts dir
		// but reports its own session id, so sharing one file would interleave
		// two writers with independent seq counters and delta bases.
		const path = dir ? join(dir, "wiretap", `${sid}.ndjson`) : undefined;
		if (path !== store.path) {
			store.path = path;
			store.dirReady = false;
			store.loading = path ? loadInto(store, path) : Promise.resolve();
		}
		return (store.loading ?? Promise.resolve()).then(() => store);
	}

	/** Log a store I/O failure unless the file is simply absent. Returns whether it was absent. */
	function storeAbsent(err: unknown): boolean {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		pi.logger.error("wiretap: store I/O failed", { error: String(err) });
		return false;
	}

	function loadInto(store: Store, path: string): Promise<void> {
		return readStore(path).then(loaded => {
			if (store.path !== path) return; // session moved on while reading
			store.captures = loaded.captures;
			store.nextSeq = loaded.nextSeq;
			store.storedBytes = loaded.bytes;
			store.fileTail = loaded.tail;
		});
	}

	function appendLine(store: Store, line: ReqLine | ResLine): boolean {
		if (!store.path) return false;
		try {
			const text = JSON.stringify(line) + "\n";
			if (!store.dirReady) {
				mkdirSync(dirname(store.path), { recursive: true });
				store.dirReady = true;
			}
			appendFileSync(store.path, text, "utf8");
			store.storedBytes += Buffer.byteLength(text);
			return true;
		} catch (err) {
			pi.logger.error("wiretap: store write failed", { error: String(err) });
			return false;
		}
	}

	function rememberBody(store: Store, seq: number, stored: StoredBody): void {
		store.memBodies.set(seq, stored);
		store.memBytes += stored.body.length;
		while (
			store.memBodies.size > 1 &&
			(store.memBodies.size > MAX_MEMORY_BODIES || store.memBytes > MAX_MEMORY_BYTES)
		) {
			const oldest = store.memBodies.keys().next();
			if (oldest.done) break;
			const evicted = store.memBodies.get(oldest.value)!;
			store.memBodies.delete(oldest.value);
			store.memBytes -= evicted.body.length;
		}
	}

	/**
	 * Reconstruct one body by replaying the store from its last full anchor.
	 * Re-reading the file per call is interactive cost, not a hot path —
	 * /wire <n> and /wire dump are the only callers.
	 */
	async function bodyFor(store: Store, seq: number): Promise<StoredBody | undefined> {
		if (store.path) {
			try {
				const text = await readFile(store.path, "utf8");
				for (const { line, body } of walkStore(text)) {
					if (line.t !== "req") continue;
					if (line.seq > seq) break;
					if (line.seq === seq) {
						return body === undefined ? undefined : { body, clipped: line.clipped === true };
					}
				}
			} catch (err) {
				storeAbsent(err);
			}
		}
		return store.memBodies.get(seq);
	}

	pi.on("before_provider_request", async (event, ctx) => {
		// Never mutate the payload, never throw: a failing handler here must not
		// take down the request it is observing.
		try {
			const store = await ensureStore(ctx);
			let body: string;
			try {
				body = JSON.stringify(event.payload, null, 2) ?? "undefined";
			} catch {
				body = String(event.payload);
			}
			// NOTE: string length, not UTF-8 bytes — display sizing only.
			const bytes = body.length;
			const clipped = bytes > MAX_BODY_BYTES;
			if (clipped) body = body.slice(0, MAX_BODY_BYTES);

			const seq = store.nextSeq++;
			const req: WireRequest = { seq, at: Date.now(), ...modelMeta(ctx.model), bytes };
			const delta =
				store.fileTail !== undefined && seq % FULL_ANCHOR_EVERY !== 0
					? encodeDelta(store.fileTail, body)
					: undefined;
			const line: ReqLine = {
				t: "req",
				seq,
				at: req.at,
				provider: req.provider,
				api: req.api,
				modelId: req.modelId,
				modelName: req.modelName,
				baseUrl: req.baseUrl,
				bytes,
			};
			if (clipped) line.clipped = true;
			if (delta) line.d = delta;
			else line.body = body;
			if (appendLine(store, line)) store.fileTail = body;
			else rememberBody(store, seq, { body, clipped });
			store.captures.push({ req });
		} catch (err) {
			pi.logger.error("wiretap: request capture failed", { error: String(err) });
		}
		return undefined;
	});

	pi.on("after_provider_response", async (event, ctx) => {
		try {
			const store = await ensureStore(ctx);
			// Pair the newest open capture: one session serializes its provider
			// requests, so older open records are stale (a response lost to a
			// crash) and must not swallow the current one. Concurrent streams in
			// one process (advisors, subagents) can still cross-wire status/timing.
			const open = [...store.captures].reverse().find(c => c.respondedAt === undefined);
			if (!open) return;
			open.respondedAt = Date.now();
			open.req.status = event.status;
			open.req.durationMs = open.respondedAt - open.req.at;
			open.req.requestId = event.requestId ?? null;
			open.headers = event.headers;
			appendLine(store, {
				t: "res",
				seq: open.req.seq,
				at: open.respondedAt,
				status: event.status,
				durationMs: open.req.durationMs,
				requestId: open.req.requestId,
				headers: event.headers,
			});
			if (ctx.hasUI) ctx.ui.setStatus("wiretap", `⇣${store.captures.length} ${event.status}`);
		} catch (err) {
			pi.logger.error("wiretap: response capture failed", { error: String(err) });
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("wiretap", undefined);
	});

	/** Publish a view into the transcript. `summary` is the LLM/headless-visible text; keep it short. */
	function show(details: WiretapDetails, summary: string): void {
		pi.sendMessage(
			{ customType: WIRETAP_MESSAGE_TYPE, content: summary, display: true, details, attribution: "agent" },
			{ triggerTurn: false },
		);
	}

	function showNote(text: string, tone: "info" | "warning" | "error" = "info"): void {
		show({ kind: "note", text, tone }, `[wiretap] ${text.split("\n")[0]}`);
	}

	function showList(store: Store): void {
		const latest = store.captures.at(-1);
		const summary = latest
			? `[wiretap] ${store.captures.length} raw provider request${store.captures.length === 1 ? "" : "s"} stored for this session; latest #${latest.req.seq} ${latest.req.provider}/${latest.req.modelId} → ${statusLabel(latest.req.status)}.`
			: "[wiretap] no provider requests captured yet in this session.";
		show(
			{ kind: "list", requests: store.captures.map(c => c.req), storedBytes: store.storedBytes + store.memBytes },
			summary,
		);
	}

	function findCapture(store: Store, arg: string | undefined): Capture | undefined {
		const seq = Number(arg);
		if (!arg || !Number.isInteger(seq)) return undefined;
		return store.captures.find(c => c.req.seq === seq);
	}

	async function showDetail(store: Store, arg: string | undefined): Promise<void> {
		const capture = findCapture(store, arg);
		if (!capture) {
			const range =
				store.captures.length > 0
					? ` Store holds #${store.captures[0].req.seq}–#${store.captures[store.captures.length - 1].req.seq}.`
					: "";
			showNote(`request #${arg} is not in this session's store.${range}`, "warning");
			return;
		}
		const r = capture.req;
		const entry = await bodyFor(store, r.seq);
		if (!entry) {
			showNote(`request #${r.seq} body is not readable from the session store.`, "warning");
			return;
		}
		const lines = entry.body.split("\n");
		const viewClipped = lines.length > BODY_VIEW_LINES;
		const notes: string[] = [];
		if (entry.clipped) {
			notes.push(`capture clipped at ${humanBytes(MAX_BODY_BYTES)} of ${humanBytes(r.bytes)} (body limit)`);
		}
		if (viewClipped) {
			notes.push(`showing ${BODY_VIEW_LINES} of ${lines.length} lines — /wire dump ${r.seq} exports the full body`);
		}
		if (capture.respondedAt === undefined) {
			notes.push("no response paired yet — in flight, failed pre-response, or cross-wired by a concurrent stream");
		}
		show(
			{
				kind: "detail",
				request: r,
				headers: Object.entries(capture.headers ?? {}),
				body: lines.slice(0, BODY_VIEW_LINES).join("\n"),
				notes,
			},
			`[wiretap] request #${r.seq}: POST ${r.baseUrl || "?"} (${r.provider}/${r.modelId}) → ${statusLabel(r.status)} · ${humanBytes(r.bytes)} body. Rendered in TUI; /wire dump ${r.seq} exports it.`,
		);
	}

	async function dump(argv: string[], ctx: ExtensionCommandContext, store: Store): Promise<void> {
		const capture = findCapture(store, argv[1]);
		if (!capture) {
			showNote(`dump: request #${argv[1] ?? "?"} is not in this session's store. /wire lists what is.`, "warning");
			return;
		}
		const entry = await bodyFor(store, capture.req.seq);
		if (!entry) {
			showNote(`dump: request #${capture.req.seq} body is not readable from the session store.`, "warning");
			return;
		}
		const target = argv[2]
			? isAbsolute(argv[2])
				? argv[2]
				: join(ctx.cwd, argv[2])
			: join(ctx.cwd, `wiretap-${capture.req.seq}.json`);
		await writeFile(target, entry.body, "utf8");
		showNote(
			`wrote ${humanBytes(entry.body.length)} → ${target}${entry.clipped ? " (clipped capture, not the full wire body)" : ""}`,
		);
	}

	pi.registerCommand("wire", {
		description: "Inspect raw LLM provider network requests captured this session",
		handler: async (args, ctx) => {
			try {
				const store = await ensureStore(ctx);
				const argv = args.trim().split(/\s+/).filter(Boolean);
				const sub = argv[0] ?? "list";
				switch (sub) {
					case "list":
						return showList(store);
					case "clear": {
						store.captures.length = 0;
						store.fileTail = undefined;
						if (store.path) {
							try {
								truncateSync(store.path, 0);
								store.storedBytes = 0;
							} catch (err) {
								if (!storeAbsent(err)) {
									showNote(`clear failed: ${String(err)}`, "error");
									return;
								}
								store.storedBytes = 0;
							}
						}
						store.memBodies.clear();
						store.memBytes = 0;
						if (ctx.hasUI) ctx.ui.setStatus("wiretap", undefined);
						return showNote("session capture store truncated (sequence numbers continue)");
					}
					case "dump":
						return await dump(argv, ctx, store);
					case "help":
					case "?":
						return showNote(
							[
								"/wire — list captured raw provider requests",
								"/wire <n> — request detail: endpoint, response status/headers, JSON body",
								"/wire dump <n> [path] — export a body to a file (default wiretap-<n>.json in cwd)",
								"/wire clear — truncate this session's capture store",
								"",
								`Captures persist with the session: bodies are stored as deltas against the previous request (full anchor every ${FULL_ANCHOR_EVERY} records), so every #1–#n stays accessible across resumes. Request headers are not exposed by the host; the body is the exact provider payload.`,
							].join("\n"),
						);
					default:
						if (/^\d+$/.test(sub)) return await showDetail(store, sub);
						return showNote(`unknown subcommand "${sub}" — try /wire help`, "warning");
				}
			} catch (err) {
				pi.logger.error("wiretap: command failed", { error: String(err) });
				showNote(`wiretap command failed: ${String(err)}`, "error");
			}
		},
	});
}
