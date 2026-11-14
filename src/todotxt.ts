// Parsing / serialization for the todo.txt format with the custom
// due:/link:/rec: extensions described in SPEC.md.

export type Priority = "A" | "B" | "C" | null;

export interface Task {
	completed: boolean;
	completionDate: string | null; // YYYY-MM-DD
	creationDate: string | null; // YYYY-MM-DD (required by spec if completed)
	priority: Priority;
	text: string; // description with recognized tokens removed
	projects: string[]; // list names, without the leading '+'
	due: string | null; // YYYY-MM-DD
	link: string | null;
	rec: string | null; // raw RRULE string
	raw: string; // the original line, verbatim
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTask(raw: string): Task {
	let s = raw.trim();
	let completed = false;
	let completionDate: string | null = null;
	let creationDate: string | null = null;
	let priority: Priority = null;

	// Completion marker: leading "x " per spec, followed by the completion date.
	if (s === "x" || s.startsWith("x ")) {
		completed = true;
		s = s.slice(1).trimStart();
		const first = s.split(/\s+/)[0] ?? "";
		if (DATE_RE.test(first)) {
			completionDate = first;
			s = s.slice(first.length).trimStart();
		}
	}

	// Priority prefix: (A) / (B) / (C) ...
	const pm = s.match(/^\(([A-Z])\)\s+/);
	if (pm) {
		priority = pm[1] as Priority;
		s = s.slice(pm[0].length);
	}

	// Creation date: a bare leading date. For completed tasks this is the
	// second date (after the completion date); for active tasks it follows
	// the optional priority.
	const lead = s.split(/\s+/)[0] ?? "";
	if (DATE_RE.test(lead)) {
		creationDate = lead;
		s = s.slice(lead.length).trimStart();
	}

	const words = s.length ? s.split(/\s+/) : [];
	const projects: string[] = [];
	let due: string | null = null;
	let link: string | null = null;
	let rec: string | null = null;
	const textWords: string[] = [];

	for (const w of words) {
		if (w.startsWith("+") && w.length > 1) {
			projects.push(w.slice(1));
		} else if (w.startsWith("due:") && w.length > 4) {
			due = w.slice(4);
		} else if (w.startsWith("link:") && w.length > 5) {
			link = w.slice(5);
		} else if (w.startsWith("rec:") && w.length > 4) {
			rec = w.slice(4);
		} else if (w.startsWith("pri:") && w.length === 5) {
			// Priority preserved on completed items (which drop the (A) prefix).
			if (!priority) priority = w.slice(4) as Priority;
		} else {
			textWords.push(w);
		}
	}

	return {
		completed,
		completionDate,
		creationDate,
		priority,
		text: textWords.join(" "),
		projects,
		due,
		link,
		rec,
		raw,
	};
}

export function serializeTask(t: Task): string {
	const parts: string[] = [];
	if (t.completed) {
		parts.push("x");
		if (t.completionDate) parts.push(t.completionDate);
	} else if (t.priority) {
		parts.push(`(${t.priority})`);
	}
	// Creation date follows the completion/priority prefix. The spec requires
	// it whenever a completion date is present.
	if (t.creationDate) parts.push(t.creationDate);
	if (t.text) parts.push(t.text);
	for (const p of t.projects) parts.push("+" + p);
	if (t.due) parts.push("due:" + t.due);
	if (t.link) parts.push("link:" + t.link);
	if (t.rec) parts.push("rec:" + t.rec);
	// A completed line drops the (A) prefix, so keep priority as a pri: key.
	if (t.completed && t.priority) parts.push("pri:" + t.priority);
	return parts.join(" ");
}

// --- upcoming -------------------------------------------------------------

// The date `days` days after `day` (both YYYY-MM-DD); negative goes back.
export function addDays(day: string, days: number): string {
	const [y, m, d] = day.split("-").map(Number);
	const dt = new Date(y, m - 1, d + days);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// The Monday strictly after `day` (a Monday maps to the one a week later).
export function nextMonday(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
	return addDays(day, ((8 - dow) % 7) || 7);
}

// The first day of the month after `day`'s.
export function firstOfNextMonth(day: string): string {
	const [y, m] = day.split("-").map(Number);
	const pad = (n: number) => String(n).padStart(2, "0");
	return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

// One-click postpone targets, shortest push first.
export function postponeTargets(
	today: string
): { icon: string; name: string; date: string }[] {
	return [
		{ icon: "chevron-right", name: "tomorrow", date: addDays(today, 1) },
		{ icon: "chevrons-right", name: "next Monday", date: nextMonday(today) },
		{
			// Registered by the view: the built-in set stops at two chevrons.
			icon: "nudge-chevrons-right-3",
			name: "the 1st of next month",
			date: firstOfNextMonth(today),
		},
	];
}

// Whether a row gets the postpone buttons: open, due today or overdue, and
// not recurring (moving a recurring task's date would shift its schedule).
export function canPostpone(t: Task, today: string): boolean {
	return !t.completed && !!t.due && t.due <= today && !t.rec;
}

// Short human date, e.g. "Mon 16 Nov" (with the year once it differs).
export function shortDate(day: string, today: string): string {
	const [y, m, d] = day.split("-").map(Number);
	const dt = new Date(y, m - 1, d);
	if (Number.isNaN(dt.getTime())) return day;
	const opts: Intl.DateTimeFormatOptions = {
		weekday: "short",
		day: "numeric",
		month: "short",
	};
	if (String(y) !== today.slice(0, 4)) opts.year = "numeric";
	return dt.toLocaleDateString(undefined, opts);
}

// How far ahead the Upcoming view looks, in picker order. No `days` means
// every future date; `hidden` removes the view from the sidebar altogether.
export const UPCOMING_RANGES: {
	id: string;
	label: string;
	days?: number;
	hidden?: boolean;
}[] = [
	{ id: "7", label: "Next 7 days", days: 7 },
	{ id: "14", label: "Next 14 days", days: 14 },
	{ id: "30", label: "Next 30 days", days: 30 },
	{ id: "all", label: "Everything with a future date" },
	{ id: "hide", label: "Hide Upcoming", hidden: true },
];
export const DEFAULT_UPCOMING_RANGE = "14";

// The configured range, falling back to the default for an unknown id.
export function upcomingRange(id: string): (typeof UPCOMING_RANGES)[number] {
	return (
		UPCOMING_RANGES.find((r) => r.id === id) ??
		UPCOMING_RANGES.find((r) => r.id === DEFAULT_UPCOMING_RANGE)!
	);
}

// Last day (inclusive) the Upcoming view covers; null = no limit.
export function upcomingEnd(today: string, rangeId: string): string | null {
	const r = upcomingRange(rangeId);
	return r.days ? addDays(today, r.days) : null;
}

// Upcoming = open, due after today, within the range.
export function isUpcoming(t: Task, today: string, end: string | null): boolean {
	if (t.completed || !t.due || t.due <= today) return false;
	return end === null || t.due <= end;
}

// Heading for a day group in Upcoming: "Tomorrow", else e.g. "Mon 16 Nov"
// (with the year once it differs from today's).
export function dayHeading(day: string, today: string): string {
	if (day === addDays(today, 1)) return "Tomorrow";
	return shortDate(day, today);
}

// --- paste ---------------------------------------------------------------

export interface PastedItem {
	text: string;
	link: string | null;
}

// What a paste into the view should do: open the new-task form with a link
// filled in (the paste was nothing but one URL), or add tasks directly.
export type PasteResult =
	| { kind: "link"; url: string }
	| { kind: "tasks"; items: PastedItem[] };

const URL_RE = /https?:\/\/[^\s<>]+/g;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
// Leading list marker: "- ", "* ", "+ ", "1. ", "1) ", optionally followed by
// a checkbox ("[ ] ", "[x] ").
const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)])(?:\s+|$)(?:\[[ xX]\](?:\s+|$))?/;

// A URL copied mid-sentence often drags trailing punctuation with it.
function trimUrl(u: string): string {
	return u.replace(/[.,;:!?'")\]]+$/, "");
}

// One pasted line → one task. A single link in the line moves to the link
// field (a markdown link keeps its title as text); with several links the
// text is left as pasted, since a task holds only one link.
function parsePastedLine(line: string): PastedItem | null {
	let text = line.trim().replace(LIST_MARKER_RE, "").trim();
	if (!text) return null;
	let link: string | null = null;

	const md = [...text.matchAll(MD_LINK_RE)];
	const bare = text.replace(MD_LINK_RE, " ").match(URL_RE) ?? [];
	if (md.length === 1 && bare.length === 0) {
		link = md[0][2];
		text = text.replace(md[0][0], md[0][1]);
	} else if (md.length === 0 && bare.length === 1) {
		link = trimUrl(bare[0]);
		// Remove the raw match, so punctuation that trailed the URL goes too.
		text = text.replace(bare[0], " ");
	}
	text = text.replace(/\s+/g, " ").trim();
	// A line that was only a URL still needs text: use the URL, minus scheme.
	if (!text && link) text = link.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return text ? { text, link } : null;
}

export function parsePaste(raw: string): PasteResult {
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length === 1) {
		const only = lines[0].trim();
		if (/^https?:\/\/\S+$/.test(only)) return { kind: "link", url: only };
	}
	const items: PastedItem[] = [];
	for (const l of lines) {
		const item = parsePastedLine(l);
		if (item) items.push(item);
	}
	return { kind: "tasks", items };
}

// --- date helpers -------------------------------------------------------

export function todayStr(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// The date `months` calendar months before `day` (both YYYY-MM-DD). The day
// of month is clamped to the target month's length (May 31 - 3 → Feb 28/29).
export function monthsBefore(day: string, months: number): string {
	const [y, m, d] = day.split("-").map(Number);
	const total = y * 12 + (m - 1) - months;
	const ty = Math.floor(total / 12);
	const tm = total - ty * 12; // 0-based
	const last = new Date(ty, tm + 1, 0).getDate();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${ty}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}

// Retention choices for completed tasks, in picker order. "never" keeps them
// forever. Weeks are counted in days, months and years in calendar months.
export const PURGE_PERIODS: {
	id: string;
	label: string;
	days?: number;
	months?: number;
}[] = [
	{ id: "never", label: "Keep forever" },
	{ id: "1w", label: "1 week", days: 7 },
	{ id: "2w", label: "2 weeks", days: 14 },
	{ id: "1m", label: "1 month", months: 1 },
	{ id: "2m", label: "2 months", months: 2 },
	{ id: "3m", label: "3 months", months: 3 },
	{ id: "6m", label: "6 months", months: 6 },
	{ id: "1y", label: "1 year", months: 12 },
];

// Cutoff date for a retention period id: tasks completed before it are
// purged. null means keep everything, which is also the answer for an
// unrecognized id, so a bad settings value can never delete data.
export function purgeCutoff(day: string, periodId: string): string | null {
	const p = PURGE_PERIODS.find((x) => x.id === periodId);
	if (!p) return null;
	if (p.months) return monthsBefore(day, p.months);
	if (p.days) {
		const [y, m, d] = day.split("-").map(Number);
		const dt = new Date(y, m - 1, d - p.days);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
	}
	return null;
}

// Whether a line is old enough to purge: completed, with a completion date
// strictly before `cutoff`. A completed line with no date is never purged,
// since its age is unknown.
export function isPurgeable(t: Task, cutoff: string): boolean {
	return t.completed && !!t.completionDate && t.completionDate < cutoff;
}

// --- visibility / filtering ---------------------------------------------

// List membership. A task with no +project tag belongs to the default list,
// so lines written by other todo.txt tools are never hidden. This is a display
// rule only: the line itself is not rewritten.
export function inList(t: Task, list: string, defaultList: string): boolean {
	if (t.projects.length === 0) return !!list && list === defaultList;
	return t.projects.includes(list);
}

// Completed items are visible only on the day they were completed (unless
// showCompletedToday is off, hiding them immediately); the day after, they
// disappear from all views regardless.
export function isVisible(
	t: Task,
	today: string,
	showCompletedToday: boolean
): boolean {
	if (!t.completed) return true;
	return showCompletedToday && t.completionDate === today;
}

// Today view = due <= today AND (not done, or completed today when shown).
export function inToday(
	t: Task,
	today: string,
	showCompletedToday: boolean
): boolean {
	if (!t.due) return false;
	if (t.due > today) return false;
	if (!t.completed) return true;
	return showCompletedToday && t.completionDate === today;
}

export function isPastDue(t: Task, today: string): boolean {
	return !!t.due && t.due < today;
}

// Project tags can't contain spaces, so a multi-word list is stored camelCase
// (e.g. "HomeChores"). For display we split it back into words. Storage is
// unaffected — this is display-only. Handles acronyms too ("HTMLParser").
// Normalize a list name for matching, ignoring spaces and case so that
// "Home Chores", "homechores", and "HomeChores" all match.
export function normalizeListName(name: string): string {
	return name.replace(/\s+/g, "").toLowerCase();
}

export function humanizeProject(name: string): string {
	return name
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.trim();
}

// --- @tags ----------------------------------------------------------------

// A tag token: '@' followed by unicode letters/digits, starting at the
// beginning of the text or after whitespace — so "user@example.com" is
// never mistaken for a tag. Tags live inline in the task text (unlike
// +project, due:, etc.) so there's nothing to strip in parseTask/
// serializeTask; this is purely a display/derivation concern.
export const TAG_TOKEN_RE = /(?<=^|\s)@([\p{L}\p{N}]+)/gu;

// Folds a handful of common non-ASCII letters (accented Latin, Polish
// ł/Ł, etc.) to their ASCII equivalent. Anything left over after NFKD
// decomposition + this map is dropped, so a tag is always pure ASCII.
const ASCII_FOLD_MAP: Record<string, string> = {
	ł: "l", Ł: "L", đ: "d", Đ: "D", ø: "o", Ø: "O", ß: "ss",
	æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", þ: "th", Þ: "Th", ð: "d", Ð: "D",
};

export function asciiFold(s: string): string {
	const decomposed = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	let out = "";
	for (const ch of decomposed) {
		out += ch.charCodeAt(0) < 128 ? ch : (ASCII_FOLD_MAP[ch] ?? "");
	}
	return out;
}

// Fold every @tag token found in a task's text to ASCII, in place. Applied
// on commit (see TodoStore.addTask/updateTask) so the file only ever holds
// ASCII tag spellings going forward; the rest of the text is untouched.
export function foldTagsInText(text: string): string {
	return text.replace(TAG_TOKEN_RE, (_m, word: string) => "@" + asciiFold(word));
}

// Unique tag variants (ASCII-folded, case preserved) mentioned in a task's
// text, in first-occurrence order. Folding here too — not just on commit —
// means a line written externally with a non-ASCII tag still counts toward
// the right tag identity before the next save rewrites it.
export function extractTaskTags(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of text.matchAll(TAG_TOKEN_RE)) {
		const variant = asciiFold(m[1]);
		const key = variant.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(variant);
	}
	return out;
}

// Split a tag's camelCase into capitalized, space-separated words for
// display: "piotrOlchawa" -> "Piotr Olchawa". Handles acronyms too
// ("HTMLParser" -> "HTML Parser"). Storage is unaffected — display-only.
export function humanizeTag(tag: string): string {
	const spaced = tag
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.trim();
	return spaced
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// Word-prefix match shared by @-mode search and the suggestion dropdown:
// the query must prefix the whole tag or any of its camelCase words, so
// "@olch" finds "piotrOlchawa" via its second word, but "@mail" does not
// match "email" (not a word start). Case/diacritic-insensitive.
export function tagMatchesQuery(tag: string, query: string): boolean {
	const q = asciiFold(query).toLowerCase();
	if (!q) return true;
	if (tag.toLowerCase().startsWith(q)) return true;
	return humanizeTag(tag)
		.split(" ")
		.some((w) => w.toLowerCase().startsWith(q));
}
