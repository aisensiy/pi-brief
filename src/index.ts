/**
 * pi-brief — session at a glance.
 *
 * Two things:
 * 1. A persistent footer status segment: session creation time + time of the last
 *    assistant reply ("Working…" while the agent is running).
 * 2. The /brief command: an overlay with the session's activity timeline (replies per
 *    day) and every user prompt (old → new), to quickly recover context when switching
 *    back to a long-lived session (e.g. in herdr).
 *
 * Data source: the full session JSONL file (every entry carries an ISO timestamp).
 * /brief reads the file instead of the active branch, so prompts from before a
 * /compact stay visible; creation time comes from the file header. The footer's last
 * reply time only scans the active branch (after compaction the last reply is always
 * in the retained region, so no full-file scan is needed). Purely local: no model
 * calls, no polling.
 *
 * Format: `Created 10-23 09:12 · Last reply 10-25 19:20`; the year is included for
 * sessions from previous years. Silent in non-TUI modes (RPC/JSON/print).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";

const STATUS_KEY = "session-times";

/** Time format shared by the footer and the overlay: MM-DD HH:mm, with year for other years. */
function formatStamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
	const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	if (d.getFullYear() === new Date().getFullYear()) {
		return `${md} ${hm}`;
	}
	return `${d.getFullYear()}-${md} ${hm}`;
}

function localDay(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Entry time: entry.timestamp is an ISO string, message.timestamp is Unix ms; fall back between them. */
function entryMs(e: SessionEntry): number {
	const outer = (e as { timestamp?: string }).timestamp;
	const ms = outer ? Date.parse(outer) : NaN;
	if (Number.isFinite(ms)) return ms;
	const inner = (e as { message?: { timestamp?: number } }).message?.timestamp;
	return typeof inner === "number" ? inner : NaN;
}

/** Creation time from the session file header (immune to compaction). NaN when unavailable. */
function readCreatedMs(ctx: ExtensionContext): number {
	try {
		const file = ctx.sessionManager.getSessionFile?.();
		if (file) {
			const head = readFileSync(file, "utf8").slice(0, 8192);
			const ts = head.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1];
			const ms = ts ? Date.parse(ts) : NaN;
			if (Number.isFinite(ms)) return ms;
		}
	} catch {
		// fall back to the first branch entry
	}
	return NaN;
}

interface BriefModel {
	createdMs: number;
	lastMs: number;
	prompts: Array<{ ms: number; text: string }>;
	/** Assistant replies per local-timezone day, ascending. */
	days: Array<{ day: string; count: number }>;
}

/** Collect overlay data from the session file (preferred) or the active branch. Null when empty. */
function buildBriefModel(ctx: ExtensionContext): BriefModel | null {
	// Prefer the full session file: compaction only rewrites the active branch and never
	// deletes original entries, so prompts from before a /compact stay visible. Without
	// a file (--no-session) or on read failure, fall back to the active branch.
	const file = ctx.sessionManager.getSessionFile?.();
	let entries: SessionEntry[] | undefined;
	if (file) {
		try {
			// Per-line tolerance: while the agent streams, the last line may be half-written;
			// skip bad lines instead of failing the whole file.
			const parsed: SessionEntry[] = [];
			for (const line of readFileSync(file, "utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					parsed.push(JSON.parse(trimmed) as SessionEntry);
				} catch {
					// half line or non-JSON, skip
				}
			}
			entries = parsed;
		} catch {
			entries = undefined;
		}
	}
	const source = entries ?? ctx.sessionManager.getBranch();
	const prompts: Array<{ ms: number; text: string }> = [];
	const dayCounts = new Map<string, number>();
	let lastMs = NaN;
	let firstMs = NaN;

	for (const e of source) {
		const ms = entryMs(e);
		if (Number.isFinite(ms)) {
			if (!Number.isFinite(firstMs)) firstMs = ms;
			if (!Number.isFinite(lastMs) || ms > lastMs) lastMs = ms;
		}
		if (e.type !== "message") continue;
		const msg = e.message as { role: string; content: unknown };
		if (msg.role === "assistant" && Number.isFinite(ms)) {
			const day = localDay(ms);
			dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
		}
		if (msg.role === "user" && Number.isFinite(ms)) {
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = (msg.content as Array<{ type?: string; text?: string }>)
					.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
					.join(" ");
			}
			// Strip expanded skill blocks; what remains is what the user actually typed.
			// A skill-only message keeps a named tag.
			const skills: string[] = [];
			text = text.replace(SKILL_BLOCK, (_m: string, name: string) => {
				skills.push(name);
				return " ";
			});
			let oneLine = text.replace(/\s+/g, " ").trim();
			if (skills.length > 0) {
				const tag = `[skill: ${skills.join(", ")}]`;
				oneLine = oneLine ? `${tag} ${oneLine}` : tag;
			}
			if (!oneLine) continue;
			// Head+tail elision for very long content (large pastes): the head is context,
			// the tail usually carries the actual request.
			if (oneLine.length > ELIDE_THRESHOLD) {
				const hidden = oneLine.length - ELIDE_HEAD - ELIDE_TAIL;
				oneLine = `${oneLine.slice(0, ELIDE_HEAD)} … ${hidden} chars omitted … ${oneLine.slice(-ELIDE_TAIL)}`;
			}
			prompts.push({ ms, text: oneLine });
		}
	}

	if (!Number.isFinite(firstMs) && prompts.length === 0) return null;

	const createdFromFile = readCreatedMs(ctx);
	return {
		createdMs: Number.isFinite(createdFromFile) ? createdFromFile : firstMs,
		lastMs,
		prompts,
		days: [...dayCounts.entries()]
			.map(([day, count]) => ({ day, count }))
			.sort((a, b) => (a.day < b.day ? -1 : 1)),
	};
}

const VIEWPORT = 18;
const OVERLAY_WIDTH = 84;
/** Max wrapped lines shown per prompt; longer ones end with a "N more chars" hint. */
const MAX_PROMPT_LINES = 3;
/** Expanded skill block: pi inlines the whole SKILL.md into the user message, wrapped in <skill> tags. */
const SKILL_BLOCK = /<skill name="([^"]*)"[^>]*>[\s\S]*?<\/skill>/g;
/** Head+tail elision thresholds for very long content (large pastes). */
const ELIDE_THRESHOLD = 300;
const ELIDE_HEAD = 72;
const ELIDE_TAIL = 48;

class BriefOverlay implements Component {
	private offset = 0;
	/** Line range [start, end) of each prompt in the body, for prompt-based scroll info. */
	private spans: Array<{ start: number; end: number }> = [];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly model: BriefModel,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		const clamp = () => {
			const maxOffset = Math.max(0, this.bodyCount() - VIEWPORT);
			this.offset = Math.max(0, Math.min(maxOffset, this.offset));
		};
		const move = (delta: number) => {
			this.offset += delta;
			clamp();
			this.tui.requestRender();
		};
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") return move(-1);
		if (matchesKey(data, "down") || data === "j") return move(1);
		if (matchesKey(data, "pageup")) return move(-VIEWPORT);
		if (matchesKey(data, "pagedown")) return move(VIEWPORT);
		if (matchesKey(data, "home") || data === "g") {
			this.offset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.offset = Number.MAX_SAFE_INTEGER;
			clamp();
			this.tui.requestRender();
		}
	}

	private bodyCount(): number {
		return this.bodyLines().length;
	}

	/** Overlay body (without border), rebuilt per render; the content is small, caching is not worth it. */
	private bodyLines(): string[] {
		const th = this.theme;
		const w = Math.max(20, OVERLAY_WIDTH - 4);
		const lines: string[] = [];
		this.spans = [];

		const parts: string[] = [];
		if (Number.isFinite(this.model.createdMs)) parts.push(`Created ${formatStamp(this.model.createdMs)}`);
		if (Number.isFinite(this.model.lastMs)) parts.push(`Last reply ${formatStamp(this.model.lastMs)}`);
		lines.push(th.fg("dim", parts.join(" · ")));
		lines.push("");
		const replies = this.model.days.reduce((n, d) => n + d.count, 0);
		const days = this.model.days.length;
		lines.push(
			th.fg(
				"dim",
				`${this.model.prompts.length} prompts · ${replies} replies · ${days} active ${days === 1 ? "day" : "days"}`,
			),
		);

		lines.push("");
		lines.push(th.fg("muted", "Timeline (replies per day)"));
		const maxCount = Math.max(...this.model.days.map((d) => d.count), 1);
		for (const d of this.model.days) {
			const barLen = Math.max(1, Math.round((d.count / maxCount) * 16));
			const label = d.day.slice(5); // MM-DD
			const bar = th.fg("accent", "▇".repeat(barLen));
			lines.push(`${th.fg("dim", label)} ${bar} ${th.fg("dim", String(d.count))}`);
		}

		lines.push("");
		lines.push(th.fg("muted", "Prompts (old → new)"));
		const tsWidth = visibleWidth("10-00 00:00  ");
		const textWidth = Math.max(10, w - tsWidth);
		const continuation = " ".repeat(tsWidth);
		for (const p of this.model.prompts) {
			const start = lines.length;
			const ts = th.fg("dim", formatStamp(p.ms).padEnd(tsWidth - 2));
			const wrapped = wrapTextWithAnsi(p.text, textWidth);
			const shown = wrapped.slice(0, MAX_PROMPT_LINES);
			shown.forEach((line, i) => lines.push(`${i === 0 ? `${ts} ` : continuation}${line}`));
			if (wrapped.length > MAX_PROMPT_LINES) {
				const hidden = p.text.length - shown.reduce((n, line) => n + line.length, 0);
				lines.push(`${continuation}${th.fg("dim", `… ${hidden} more chars`)} `);
			}
			this.spans.push({ start, end: lines.length });
		}
		return lines;
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const body = this.bodyLines();
		const maxOffset = Math.max(0, body.length - VIEWPORT);
		this.offset = Math.max(0, Math.min(maxOffset, this.offset));

		// Only show a position indicator when scrollable: which prompts are in view, or
		// "Timeline" while the window is still above the prompt list.
		let scrollInfo = "";
		if (maxOffset > 0) {
			const winEnd = Math.min(body.length, this.offset + VIEWPORT);
			const visible = this.spans
				.map((s, i) => (s.end > this.offset && s.start < winEnd ? i : -1))
				.filter((i) => i >= 0);
			if (visible.length > 0) {
				const first = visible[0]! + 1;
				const last = visible[visible.length - 1]! + 1;
				scrollInfo
					= first === last
						? `Prompt ${first}/${this.model.prompts.length} · `
						: `Prompts ${first}-${last}/${this.model.prompts.length} · `;
			} else {
				scrollInfo = "Timeline · ";
			}
		}
		const hint = `${scrollInfo}q close · ↑↓ scroll`;
		const hintLine = ` ${th.fg("dim", truncateToWidth(hint, innerW - 2, "…"))}`;

		const visible = [...body.slice(this.offset, this.offset + VIEWPORT), hintLine];

		const titleStr = truncateToWidth(" Session brief ", innerW);
		const titleW = visibleWidth(titleStr);
		const dash = (n: number) => th.fg("border", "─".repeat(Math.max(0, n)));
		const leftDashes = Math.floor((innerW - titleW) / 2);
		const top = th.fg("border", "╭")
			+ dash(leftDashes)
			+ th.fg("accent", titleStr)
			+ dash(innerW - titleW - leftDashes)
			+ th.fg("border", "╮");
		const rows = [top];
		for (const line of visible) {
			rows.push(th.fg("border", "│") + truncateToWidth(` ${line}`, innerW, "…", true) + th.fg("border", "│"));
		}
		rows.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return rows;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI): void {
	let createdMs = NaN;
	let lastMs = NaN;
	let busy = false;

	const renderStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const parts: string[] = [];
		if (Number.isFinite(createdMs)) parts.push(`Created ${formatStamp(createdMs)}`);
		if (busy) parts.push("Working…");
		else if (Number.isFinite(lastMs)) parts.push(`Last reply ${formatStamp(lastMs)}`);
		ctx.ui.setStatus(STATUS_KEY, parts.length ? ctx.ui.theme.fg("dim", parts.join(" · ")) : undefined);
	};

	const refresh = (ctx: ExtensionContext) => {
		lastMs = NaN;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			const ms = entryMs(e);
			if (Number.isFinite(ms) && (!Number.isFinite(lastMs) || ms > lastMs)) lastMs = ms;
		}
		if (!Number.isFinite(createdMs)) {
			const first = ctx.sessionManager.getBranch()[0];
			const fromBranch = first ? entryMs(first) : NaN;
			const fromHeader = readCreatedMs(ctx);
			createdMs = Number.isFinite(fromHeader) ? fromHeader : fromBranch;
		}
		renderStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		createdMs = NaN;
		busy = false;
		refresh(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		busy = true;
		renderStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		busy = false;
		refresh(ctx);
	});

	pi.registerCommand("brief", {
		description: "Session brief: activity timeline and prompt history",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/brief needs an interactive terminal", "error");
				return;
			}
			const model = buildBriefModel(ctx);
			if (!model) {
				ctx.ui.notify("Empty session, nothing to show", "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new BriefOverlay(tui, theme, model, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: OVERLAY_WIDTH, maxHeight: VIEWPORT + 4 } },
			);
		},
	});
}
