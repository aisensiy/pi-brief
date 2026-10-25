/**
 * pi-brief — 会话速览。
 *
 * 两件事：
 * 1. footer 常驻状态段：会话创建时间 + 最后一次回复时间（agent 运行时显示「回复中…」）。
 * 2. /brief 命令：覆盖层展示本会话的时间线（按天回复数）和全部用户提问（旧 → 新），
 *    帮助在 herdr 里切回一个挂了很久的会话时快速恢复上下文。
 *
 * 数据来源：session 文件全量 JSONL（每条带 ISO 时间戳）。/brief 读文件而不是活动
 * 分支，所以 compaction 之后旧提问照样可见；创建时间取文件头部时间戳。footer 的
 * 最后回复时间只查活动分支（压缩后最后一条回复必然在保留区，不必扫全文件）。
 * 纯本地计算，不发起模型调用，不轮询。
 *
 * 显示格式：`创建 10-23 09:12 · 回复 10-25 19:20`，跨年带年份。
 * 非 TUI 模式（RPC/JSON/print）静默。
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

/** footer 状态段与覆盖层共用的时间格式：当年 MM-DD HH:mm，跨年带年份。 */
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

/** 条目时间：entry.timestamp 是 ISO 字符串，message.timestamp 是 Unix 毫秒，做个兜底。 */
function entryMs(e: SessionEntry): number {
	const outer = (e as { timestamp?: string }).timestamp;
	const ms = outer ? Date.parse(outer) : NaN;
	if (Number.isFinite(ms)) return ms;
	const inner = (e as { message?: { timestamp?: number } }).message?.timestamp;
	return typeof inner === "number" ? inner : NaN;
}

/** 从 session 文件头部读创建时间（与 compaction 无关）。读不到返回 NaN。 */
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
		// 读失败就退回 branch 首条时间
	}
	return NaN;
}

interface BriefModel {
	createdMs: number;
	lastMs: number;
	prompts: Array<{ ms: number; text: string }>;
	/** 按天（本地时区）统计的 assistant 回复数，升序。 */
	days: Array<{ day: string; count: number }>;
}

/** 从当前 branch 或 session 文件提取覆盖层要用的全部数据。空会话返回 null。 */
function buildBriefModel(ctx: ExtensionContext): BriefModel | null {
	// 优先读 session 文件全量历史：compaction 只改活动分支，不删文件里的原始条目，
	// 这样 compact 过的旧会话照样能看到完整提问列表和时间线。没有文件
	// （--no-session 的临时会话）或读失败时退回当前 branch。
	const file = ctx.sessionManager.getSessionFile?.();
	let entries: SessionEntry[] | undefined;
	if (file) {
		try {
			// 逐行容错：agent 流式写入时最后一行可能只写了一半，坏行跳过而不是整体失败。
			const parsed: SessionEntry[] = [];
			for (const line of readFileSync(file, "utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					parsed.push(JSON.parse(trimmed) as SessionEntry);
				} catch {
					// 半行或非 JSON 行，跳过
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
			// 剥掉 skill 展开块，剩下的才是用户敲的字；纯 skill 消息用名字占位
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
			// 超长粘贴类内容拒头去尾：开头是上下文，结尾往往是真正的诉求
			if (oneLine.length > ELIDE_THRESHOLD) {
				const hidden = oneLine.length - ELIDE_HEAD - ELIDE_TAIL;
				oneLine = `${oneLine.slice(0, ELIDE_HEAD)} ……中间省略 ${hidden} 字…… ${oneLine.slice(-ELIDE_TAIL)}`;
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
/** 每条提问最多展示的折行数，超出的用剩余字数提示收尾。 */
const MAX_PROMPT_LINES = 3;
/** skill 展开块：pi 会把整个 SKILL.md 塞进 user message，用 <skill name="...">...</skill> 包裹。 */
const SKILL_BLOCK = /<skill name="([^"]*)"[^>]*>[\s\S]*?<\/skill>/g;
/** 超长内容（整段粘贴等）的拒头去尾阈值与保留量，避免粘贴淹没问题本身。 */
const ELIDE_THRESHOLD = 300;
const ELIDE_HEAD = 72;
const ELIDE_TAIL = 48;

class BriefOverlay implements Component {
	private offset = 0;

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

	/** 覆盖层正文（不含边框），每次按当前宽度重建；内容量小，不值得缓存。 */
	private bodyLines(): string[] {
		const th = this.theme;
		const w = Math.max(20, OVERLAY_WIDTH - 4);
		const lines: string[] = [];

		const parts: string[] = [];
		if (Number.isFinite(this.model.createdMs)) parts.push(`创建 ${formatStamp(this.model.createdMs)}`);
		if (Number.isFinite(this.model.lastMs)) parts.push(`最后回复 ${formatStamp(this.model.lastMs)}`);
		lines.push(th.fg("dim", parts.join(" · ")));
		lines.push("");
		lines.push(
			th.fg(
				"dim",
				`${this.model.prompts.length} 次提问 · ${this.model.days.reduce((n, d) => n + d.count, 0)} 轮回复 · 活跃 ${this.model.days.length} 天`,
			),
		);

		lines.push("");
		lines.push(th.fg("muted", "时间线（每天回复数）"));
		const maxCount = Math.max(...this.model.days.map((d) => d.count), 1);
		for (const d of this.model.days) {
			const barLen = Math.max(1, Math.round((d.count / maxCount) * 16));
			const label = d.day.slice(5); // MM-DD
			const bar = th.fg("accent", "▇".repeat(barLen));
			lines.push(`${th.fg("dim", label)} ${bar} ${th.fg("dim", String(d.count))}`);
		}

		lines.push("");
		lines.push(th.fg("muted", "提问（旧 → 新）"));
		const tsWidth = visibleWidth("10-00 00:00  ");
		const textWidth = Math.max(10, w - tsWidth);
		const continuation = " ".repeat(tsWidth);
		for (const p of this.model.prompts) {
			const ts = th.fg("dim", formatStamp(p.ms).padEnd(tsWidth - 2));
			const wrapped = wrapTextWithAnsi(p.text, textWidth);
			const shown = wrapped.slice(0, MAX_PROMPT_LINES);
			shown.forEach((line, i) => lines.push(`${i === 0 ? `${ts} ` : continuation}${line}`));
			if (wrapped.length > MAX_PROMPT_LINES) {
				const hidden = p.text.length - shown.reduce((n, line) => n + line.length, 0);
				lines.push(`${continuation}${th.fg("dim", `…其余 ${hidden} 字`)} `);
			}
		}
		return lines;
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const body = this.bodyLines();
		const maxOffset = Math.max(0, body.length - VIEWPORT);
		this.offset = Math.max(0, Math.min(maxOffset, this.offset));

		// 内容超屏时才显示行号窗口，否则纯噪音
		const scrollInfo = maxOffset > 0
			? `第 ${this.offset + 1}-${Math.min(body.length, this.offset + VIEWPORT)} 行，共 ${body.length} 行 · `
			: "";
		const hint = `${scrollInfo}q 关闭 · ↑↓ 滚动`;
		const hintLine = ` ${th.fg("dim", truncateToWidth(hint, innerW - 2, "…"))}`;

		const visible = [...body.slice(this.offset, this.offset + VIEWPORT), hintLine];

		const titleStr = truncateToWidth(" 会话速览 ", innerW);
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
		if (Number.isFinite(createdMs)) parts.push(`创建 ${formatStamp(createdMs)}`);
		if (busy) parts.push("回复中…");
		else if (Number.isFinite(lastMs)) parts.push(`回复 ${formatStamp(lastMs)}`);
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
		description: "会话速览：时间线与提问列表",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/brief 需要终端界面", "error");
				return;
			}
			const model = buildBriefModel(ctx);
			if (!model) {
				ctx.ui.notify("空会话，没有内容可看", "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new BriefOverlay(tui, theme, model, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: OVERLAY_WIDTH, maxHeight: VIEWPORT + 4 } },
			);
		},
	});
}
