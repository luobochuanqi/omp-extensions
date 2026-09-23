import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	WIRETAP_MESSAGE_TYPE,
	humanBytes,
	renderWiretap,
	statusLabel,
	type WireRequest,
	type WiretapDetails,
} from "./render";

// Capture buffer limits. Bodies are held pretty-printed in memory only (raw
// wire payloads routinely carry MBs of context and base64 images); the byte
// budget evicts oldest-first so a long session cannot grow unbounded.
const MAX_CAPTURES = 32;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** Body lines persisted into one detail view; the full body goes to /wire dump. */
const BODY_VIEW_LINES = 600;

interface Capture {
	req: WireRequest;
	/** Pretty-printed JSON of the request payload; clipped at MAX_BODY_BYTES. */
	body: string;
	bodyClipped: boolean;
	headers?: Record<string, string>;
	respondedAt?: number;
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

	const captures: Capture[] = [];
	let nextSeq = 1;
	let dropped = 0;
	let bufferedBytes = 0;

	pi.on("before_provider_request", (event, ctx) => {
		// Never mutate the payload, never throw: a failing handler here must not
		// take down the request it is observing.
		try {
			let body: string;
			try {
				body = JSON.stringify(event.payload, null, 2) ?? "undefined";
			} catch {
				body = String(event.payload);
			}
			// NOTE: string length, not UTF-8 bytes — display sizing only.
			const bytes = body.length;
			const bodyClipped = bytes > MAX_BODY_BYTES;
			if (bodyClipped) body = body.slice(0, MAX_BODY_BYTES);
			captures.push({
				req: { seq: nextSeq++, at: Date.now(), bytes, ...modelMeta(ctx.model) },
				body,
				bodyClipped,
			});
			bufferedBytes += body.length;
			while (captures.length > 1 && (captures.length > MAX_CAPTURES || bufferedBytes > MAX_TOTAL_BYTES)) {
				const old = captures.shift();
				if (!old) break;
				bufferedBytes -= old.body.length;
				dropped++;
			}
		} catch (err) {
			pi.logger.error("wiretap: request capture failed", { error: String(err) });
		}
		return undefined;
	});

	pi.on("after_provider_response", (event, ctx) => {
		try {
			// ponytail: FIFO pairing — a session serializes its provider requests, so
			// the oldest open capture owns this response. Concurrent sessions sharing
			// this process (subagents) can cross-wire; status/timing stay approximate.
			const open = captures.find(c => c.respondedAt === undefined);
			if (!open) return;
			open.respondedAt = Date.now();
			open.req.status = event.status;
			open.req.durationMs = open.respondedAt - open.req.at;
			open.req.requestId = event.requestId ?? null;
			open.headers = event.headers;
			if (ctx.hasUI) ctx.ui.setStatus("wiretap", `⇣${captures.length} ${event.status}`);
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

	function showList(): void {
		const latest = captures.at(-1);
		const summary = latest
			? `[wiretap] ${captures.length} raw provider request${captures.length === 1 ? "" : "s"} buffered; latest #${latest.req.seq} ${latest.req.provider}/${latest.req.modelId} → ${statusLabel(latest.req.status)}.`
			: "[wiretap] no provider requests captured yet in this process.";
		show(
			{ kind: "list", requests: captures.map(c => c.req), dropped, bufferedBytes },
			summary,
		);
	}

	function findCapture(arg: string | undefined): Capture | undefined {
		const seq = Number(arg);
		if (!arg || !Number.isInteger(seq)) return undefined;
		return captures.find(c => c.req.seq === seq);
	}

	function showDetail(arg: string | undefined): void {
		const capture = findCapture(arg);
		if (!capture) {
			const range = captures.length > 0 ? ` Buffer holds #${captures[0].req.seq}–#${captures[captures.length - 1].req.seq}.` : "";
			showNote(`request #${arg} is not in the capture buffer.${range}`, "warning");
			return;
		}
		const r = capture.req;
		const lines = capture.body.split("\n");
		const viewClipped = lines.length > BODY_VIEW_LINES;
		const notes: string[] = [];
		if (capture.bodyClipped) {
			notes.push(`capture clipped at ${humanBytes(MAX_BODY_BYTES)} of ${humanBytes(r.bytes)} (buffer limit)`);
		}
		if (viewClipped) {
			notes.push(`showing ${BODY_VIEW_LINES} of ${lines.length} lines — /wire dump ${r.seq} exports the full body`);
		}
		if (capture.respondedAt === undefined) {
			notes.push("no response paired yet — in flight, failed pre-response, or cross-wired by a concurrent session");
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

	async function dump(argv: string[], ctx: ExtensionCommandContext): Promise<void> {
		const capture = findCapture(argv[1]);
		if (!capture) {
			showNote(`dump: request #${argv[1] ?? "?"} is not in the capture buffer. /wire lists what is.`, "warning");
			return;
		}
		const target = argv[2]
			? isAbsolute(argv[2])
				? argv[2]
				: join(ctx.cwd, argv[2])
			: join(ctx.cwd, `wiretap-${capture.req.seq}.json`);
		await writeFile(target, capture.body, "utf8");
		showNote(
			`wrote ${humanBytes(capture.body.length)} → ${target}${capture.bodyClipped ? " (clipped capture, not the full wire body)" : ""}`,
		);
	}

	pi.registerCommand("wire", {
		description: "Inspect raw LLM provider network requests captured this session",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0] ?? "list";
			try {
				switch (sub) {
					case "list":
						return showList();
					case "clear":
						captures.length = 0;
						bufferedBytes = 0;
						dropped = 0;
						if (ctx.hasUI) ctx.ui.setStatus("wiretap", undefined);
						return showNote("capture buffer cleared (sequence numbers continue)");
					case "dump":
						return await dump(argv, ctx);
					case "help":
					case "?":
						return showNote(
							[
								"/wire — list captured raw provider requests",
								"/wire <n> — request detail: endpoint, response status/headers, JSON body",
								"/wire dump <n> [path] — export a body to a file (default wiretap-<n>.json in cwd)",
								"/wire clear — empty the capture buffer",
								"",
								`In-memory, per-process: last ${MAX_CAPTURES} requests within a ${humanBytes(MAX_TOTAL_BYTES)} budget. Request headers are not exposed by the host; the body is the exact provider payload.`,
							].join("\n"),
						);
					default:
						if (/^\d+$/.test(sub)) return showDetail(sub);
						return showNote(`unknown subcommand "${sub}" — try /wire help`, "warning");
				}
			} catch (err) {
				pi.logger.error("wiretap: command failed", { error: String(err) });
				showNote(`wiretap command failed: ${String(err)}`, "error");
			}
		},
	});
}
