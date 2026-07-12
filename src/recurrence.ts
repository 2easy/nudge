// Recurrence: builds/parses RRULE strings for the structured picker and
// computes the next occurrence via the `rrule` package.

import { RRule, type Options } from "rrule";

export type RecType =
	| "none"
	| "daily"
	| "weekly"
	| "monthly"
	| "workdays"
	| "nth";

export interface RecState {
	type: RecType;
	interval: number; // >= 1
	weekdays: string[]; // for "weekly": subset of WEEKDAY_CODES
	nth: number; // for "nth": 1..5 or -1 (last)
	nthWeekday: string; // for "nth": one of WEEKDAY_CODES
}

export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const WEEKDAY_LABELS: Record<string, string> = {
	MO: "Mon",
	TU: "Tue",
	WE: "Wed",
	TH: "Thu",
	FR: "Fri",
	SA: "Sat",
	SU: "Sun",
};
const WORKDAYS = "MO,TU,WE,TH,FR";

export function defaultRecState(): RecState {
	return { type: "none", interval: 1, weekdays: [], nth: 1, nthWeekday: "MO" };
}

function intervalSuffix(n: number): string {
	return n > 1 ? `;INTERVAL=${n}` : "";
}

export function buildRRule(s: RecState): string | null {
	switch (s.type) {
		case "none":
			return null;
		case "daily":
			return `FREQ=DAILY${intervalSuffix(s.interval)}`;
		case "weekly": {
			const byday = s.weekdays.length ? `;BYDAY=${s.weekdays.join(",")}` : "";
			return `FREQ=WEEKLY${intervalSuffix(s.interval)}${byday}`;
		}
		case "monthly":
			return `FREQ=MONTHLY${intervalSuffix(s.interval)}`;
		case "workdays":
			return `FREQ=WEEKLY;BYDAY=${WORKDAYS}`;
		case "nth":
			return `FREQ=MONTHLY;BYDAY=${s.nth}${s.nthWeekday}`;
	}
}

export function parseRRule(rec: string | null): RecState {
	const state = defaultRecState();
	if (!rec) return state;

	const freq = (rec.match(/FREQ=([A-Z]+)/) ?? [])[1] ?? "";
	const interval = Number((rec.match(/INTERVAL=(\d+)/) ?? [])[1] ?? "1") || 1;
	const byday = (rec.match(/BYDAY=([^;]+)/) ?? [])[1] ?? "";
	state.interval = interval;

	if (freq === "WEEKLY" && byday === WORKDAYS) {
		state.type = "workdays";
	} else if (freq === "MONTHLY" && /^(-?\d+)([A-Z]{2})$/.test(byday)) {
		const m = byday.match(/^(-?\d+)([A-Z]{2})$/)!;
		state.type = "nth";
		state.nth = Number(m[1]);
		state.nthWeekday = m[2];
	} else if (freq === "WEEKLY") {
		state.type = "weekly";
		state.weekdays = byday ? byday.split(",") : [];
	} else if (freq === "DAILY") {
		state.type = "daily";
	} else if (freq === "MONTHLY") {
		state.type = "monthly";
	}
	return state;
}

// Next occurrence strictly after `anchor` (YYYY-MM-DD), anchored on the
// original due date so late completion doesn't drift the schedule.
export function nextOccurrence(rec: string, anchor: string): string | null {
	try {
		const [y, m, d] = anchor.split("-").map(Number);
		const start = new Date(Date.UTC(y, m - 1, d));
		const opts: Partial<Options> = RRule.parseString(rec);
		opts.dtstart = start;
		const rule = new RRule(opts);
		const next: Date | null = rule.after(start, false);
		if (!next) return null;
		const ny = next.getUTCFullYear();
		const nm = String(next.getUTCMonth() + 1).padStart(2, "0");
		const nd = String(next.getUTCDate()).padStart(2, "0");
		return `${ny}-${nm}-${nd}`;
	} catch {
		return null;
	}
}
