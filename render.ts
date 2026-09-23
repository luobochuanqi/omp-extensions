import type { Component, Theme, ThemeColor } from "@oh-my-pi/pi-tui";
import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

/** Session customType carrying a wiretap view. Package-qualified per extension docs. */
export const WIRETAP_MESSAGE_TYPE = "omp-wiretap.view";

/** One captured provider request, serializable into session details. */
export interface WireRequest {
	seq: number;
	/** Capture start, epoch ms. Relative labels are computed at render time. */
	at: number;
	provider: string;
	api: string;
	modelId: string;
	modelName: string;
	baseUrl: string;
	/** Size of the full serialized body in bytes, before any capture clipping. */
	bytes: number;
	/** Undefined while the response has not been paired. */
	status?: number;
	/** Time to first response metadata (before stream body is consumed). */
	durationMs?: number;
	requestId?: string | null;
}

export type WiretapDetails =
	| { kind: "list"; requests: WireRequest[]; dropped: number; bufferedBytes: number }
	| {
			kind: "detail";
			request: WireRequest;
			headers: [string, string][];
			/** Pretty-printed JSON body, already capped by the command layer. */
			body: string;
			/** Truncation / pairing caveats, rendered as warning lines. */
			notes: string[];
	  }
	| { kind: "note"; text: string; tone?: "info" | "warning" | "error" };

export function isWiretapDetails(value: unknown): value is WiretapDetails {
	if (typeof value !== "object" || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return kind === "list" || kind === "detail" || kind === "note";
}

// Formatting helpers shared with the command layer for plain-text summaries.

export function humanBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n < 1024) return `${Math.round(n)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n;
	let u = -1;
	do {
		v /= 1024;
		u++;
	} while (v >= 1024 && u < units.length - 1);
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function humanDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export function clockTime(at: number): string {
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact age for table columns: `now`, `12s`, `3m`, `2h`, `5d`. */
export function ageLabel(at: number, now: number = Date.now()): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 5) return "now";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function statusColor(status: number | undefined): ThemeColor {
	if (status === undefined) return "dim";
	if (status >= 500) return "error";
	if (status >= 400) return "warning";
	if (status >= 300) return "accent";
	return "success";
}

/** Shared so every surface spells an unpaired request the same way. */
export function statusLabel(status: number | undefined): string {
	return status === undefined ? "···" : String(status);
}

// JSON highlighting. The body is always JSON.stringify output, so a
// line-scoped tokenizer is exact: strings never span lines (newlines are
// escaped) and every token is one of the five JSON forms.

const JSON_TOKEN_RE =
	/("(?:[^"\\]|\\.)*")(\s*:)?|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** Inline string values longer than this are elided in the rendered view. */
const MAX_STRING_TOKEN = 240;

function elideJsonString(raw: string, theme: Theme): string {
	// Never cut an escape pair in half: drop the trailing backslash if odd.
	let head = raw.slice(0, 80);
	const run = head.length - head.replace(/\\+$/, "").length;
	if (run % 2 === 1) head = head.slice(0, -1);
	return `${theme.fg("syntaxString", `${head}…`)}${theme.fg("dim", ` (${humanBytes(raw.length - 2)})`)}`;
}

export function highlightJsonLine(line: string, theme: Theme): string {
	let out = "";
	let last = 0;
	for (const m of line.matchAll(JSON_TOKEN_RE)) {
		const idx = m.index ?? 0;
		out += line.slice(last, idx);
		const [, str, colon, num, lit, punct] = m;
		if (str !== undefined) {
			if (colon !== undefined) {
				out += theme.fg("syntaxVariable", str) + theme.fg("dim", colon);
			} else if (str.length > MAX_STRING_TOKEN) {
				out += elideJsonString(str, theme);
			} else {
				out += theme.fg("syntaxString", str);
			}
		} else if (num !== undefined) {
			out += theme.fg("syntaxNumber", num);
		} else if (lit !== undefined) {
			out += theme.fg("syntaxKeyword", lit);
		} else if (punct !== undefined) {
			out += theme.fg("dim", punct);
		}
		last = idx + m[0].length;
	}
	return out + line.slice(last);
}

// Card component.

/** Rows kept for a collapsed list view; expansion shows the full buffer. */
const LIST_COLLAPSED_ROWS = 8;
/** Body lines kept for a collapsed detail view. */
const BODY_COLLAPSED_LINES = 40;

function pad(text: string, width: number, right = false): string {
	const gap = Math.max(0, width - visibleWidth(text));
	return right ? " ".repeat(gap) + text : text + " ".repeat(gap);
}

class WiretapCard implements Component {
	readonly debugKind = "WiretapCard";
	#details: WiretapDetails;
	#expanded: boolean;
	#theme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(details: WiretapDetails, expanded: boolean, theme: Theme) {
		this.#details = details;
		this.#expanded = expanded;
		this.#theme = theme;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		const w = Math.max(24, Math.floor(width));
		if (this.#cache?.width === w) return this.#cache.lines;
		const d = this.#details;
		let lines: string[];
		switch (d.kind) {
			case "list":
				lines = this.#renderList(w, d);
				break;
			case "detail":
				lines = this.#renderDetail(w, d);
				break;
			case "note":
				lines = this.#renderNote(w, d);
				break;
		}
		this.#cache = { width: w, lines };
		return lines;
	}

	#fit(line: string, width: number): string {
		return truncateToWidth(line, width, Ellipsis.Unicode);
	}

	#header(width: number, right: string): string[] {
		const t = this.#theme;
		const left = `${t.fg("accent", t.cmd.globe)} ${t.fg("customMessageLabel", t.bold("WIRETAP"))}`;
		const styledRight = t.fg("dim", right);
		const gap = width - visibleWidth(left) - visibleWidth(styledRight);
		const head = gap >= 1 ? left + " ".repeat(gap) + styledRight : `${left} ${styledRight}`;
		return [this.#fit(head, width), t.fg("borderMuted", t.boxRound.horizontal.repeat(width))];
	}

	#rule(width: number, title: string): string {
		const t = this.#theme;
		const dash = t.boxRound.horizontal;
		const styled = `${t.fg("borderMuted", `${dash}${dash} `)}${t.fg("muted", title)}${t.fg("borderMuted", " ")}`;
		const fill = Math.max(0, width - visibleWidth(styled));
		return styled + t.fg("borderMuted", dash.repeat(fill));
	}

	#renderList(width: number, d: Extract<WiretapDetails, { kind: "list" }>): string[] {
		const t = this.#theme;
		const n = d.requests.length;
		const right =
			n > 0
				? `${n} request${n === 1 ? "" : "s"}${d.dropped > 0 ? ` · ${d.dropped} evicted` : ""} · ${humanBytes(d.bufferedBytes)}`
				: "idle";
		const lines = this.#header(width, right);

		if (d.requests.length === 0) {
			lines.push(
				t.fg("dim", `${t.status.pending} no requests captured yet — the buffer fills as this session talks to providers`),
			);
			return lines.map(l => this.#fit(l, width));
		}

		const now = Date.now();
		let rows = d.requests;
		let hidden = 0;
		if (!this.#expanded && rows.length > LIST_COLLAPSED_ROWS) {
			hidden = rows.length - LIST_COLLAPSED_ROWS;
			rows = rows.slice(-LIST_COLLAPSED_ROWS);
		}

		const cells = rows.map(r => ({
			r,
			seq: String(r.seq),
			when: ageLabel(r.at, now),
			st: statusLabel(r.status),
			ttfb: r.durationMs === undefined ? "—" : humanDuration(r.durationMs),
			size: humanBytes(r.bytes),
		}));
		const cols = {
			seq: Math.max(1, ...cells.map(c => c.seq.length)),
			when: Math.max(4, ...cells.map(c => c.when.length)),
			st: 3,
			ttfb: Math.max(5, ...cells.map(c => c.ttfb.length)),
			size: Math.max(6, ...cells.map(c => c.size.length)),
		};
		const gap = 2;
		const endW = Math.max(8, width - (cols.seq + cols.when + cols.st + cols.ttfb + cols.size + gap * 5));

		const headerRow = [
			pad("#", cols.seq, true),
			pad("WHEN", cols.when),
			pad("ENDPOINT", endW),
			pad("ST", cols.st, true),
			pad("TTFB", cols.ttfb, true),
			pad("SIZE", cols.size, true),
		].join(" ".repeat(gap));
		lines.push(t.fg("dim", truncateToWidth(headerRow, width, Ellipsis.Omit)));

		cells.forEach((c, i) => {
			const isLast = i === cells.length - 1;
			const endpoint = truncateToWidth(
				`${t.fg("muted", c.r.provider)}${t.fg("dim", "/")}${t.fg("text", c.r.modelId)}`,
				endW,
				Ellipsis.Unicode,
			);
			lines.push(
				[
					pad(t.fg(isLast ? "accent" : "muted", isLast ? t.bold(c.seq) : c.seq), cols.seq, true),
					pad(t.fg("dim", c.when), cols.when),
					pad(endpoint, endW),
					pad(t.fg(statusColor(c.r.status), c.st), cols.st, true),
					pad(t.fg(c.r.durationMs === undefined ? "dim" : "muted", c.ttfb), cols.ttfb, true),
					pad(t.fg("muted", c.size), cols.size, true),
				].join(" ".repeat(gap)),
			);
		});

		if (hidden > 0) {
			lines.push(t.fg("dim", `${t.nav.expand} ${hidden} earlier — expand tool output to see all`));
		}
		return lines.map(l => this.#fit(l, width));
	}

	#renderDetail(width: number, d: Extract<WiretapDetails, { kind: "detail" }>): string[] {
		const t = this.#theme;
		const r = d.request;
		const lines = this.#header(width, `#${r.seq} · ${clockTime(r.at)} · ${ageLabel(r.at)} ago`);

		lines.push(`${t.fg("accent", t.bold("POST"))} ${t.fg("text", r.baseUrl || "(unknown endpoint)")}`);
		const model = r.modelName && r.modelName !== r.modelId ? `${r.modelName} (${r.modelId})` : r.modelId;
		lines.push(t.fg("muted", `${r.api} · ${model}`));
		lines.push("");

		const statusParts = [
			`${t.fg(statusColor(r.status), "●")} ${t.fg(statusColor(r.status), t.bold(statusLabel(r.status)))}`,
			t.fg("muted", r.durationMs === undefined ? "awaiting response" : `ttfb ${humanDuration(r.durationMs)}`),
		];
		if (r.requestId) statusParts.push(t.fg("dim", `id ${r.requestId}`));
		lines.push(statusParts.join(t.fg("dim", ` ${t.sep.dot} `)));

		if (d.headers.length > 0) {
			lines.push(this.#rule(width, `RESPONSE HEADERS · ${d.headers.length}`));
			const keyW = Math.min(28, Math.max(...d.headers.map(([k]) => k.length)));
			for (const [k, v] of d.headers) {
				lines.push(`${pad(truncateToWidth(t.fg("dim", k), keyW, Ellipsis.Unicode), keyW)}  ${t.fg("muted", v)}`);
			}
		}

		lines.push(this.#rule(width, `REQUEST BODY · ${humanBytes(r.bytes)}`));
		const bodyLines = d.body.split("\n");
		const shown = this.#expanded ? bodyLines : bodyLines.slice(0, BODY_COLLAPSED_LINES);
		for (const line of shown) {
			lines.push(highlightJsonLine(line, t));
		}
		if (!this.#expanded && bodyLines.length > shown.length) {
			lines.push(
				t.fg(
					"dim",
					`${t.nav.expand} ${bodyLines.length - shown.length} more lines — expand tool output, or /wire dump ${r.seq}`,
				),
			);
		}
		for (const note of d.notes) {
			lines.push(t.fg("warning", `! ${note}`));
		}
		return lines.map(l => this.#fit(l, width));
	}

	#renderNote(width: number, d: Extract<WiretapDetails, { kind: "note" }>): string[] {
		const t = this.#theme;
		const tone = d.tone ?? "info";
		const icon = tone === "error" ? t.status.error : tone === "warning" ? t.status.warning : t.status.info;
		const iconColor: ThemeColor = tone === "error" ? "error" : tone === "warning" ? "warning" : "accent";
		const gutter = `${t.fg(iconColor, icon)} `;
		const gutterW = visibleWidth(gutter);
		const out: string[] = [];
		for (const para of d.text.split("\n")) {
			const wrapped = para.length > 0 ? wrapTextWithAnsi(para, Math.max(8, width - gutterW)) : [""];
			wrapped.forEach((wl, i) => {
				out.push(this.#fit(i === 0 ? gutter + wl : " ".repeat(gutterW) + wl, width));
			});
		}
		return out;
	}
}

export function renderWiretap(
	message: { details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	if (!isWiretapDetails(message.details)) return undefined;
	return new WiretapCard(message.details, options.expanded, theme);
}
