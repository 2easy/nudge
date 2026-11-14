// File-backed store. There is no long-lived cache: reads pull the file fresh,
// and every mutation goes through Vault.process(), which reads-modifies-writes
// atomically (see SPEC.md § Concurrency).

import { App, TFile, normalizePath } from "obsidian";
import {
	extractTaskTags,
	foldTagsInText,
	isPurgeable,
	humanizeTag,
	parseTask,
	replaceProject,
	serializeTask,
	Task,
	todayStr,
} from "./todotxt";
import { nextOccurrence } from "./recurrence";

export interface RenderTask {
	task: Task;
	index: number; // physical line index in the file
}

export class TodoStore {
	private path: string;

	constructor(private app: App, path: string) {
		this.path = normalizePath(path);
	}

	setPath(p: string): void {
		this.path = normalizePath(p);
	}

	getPath(): string {
		return this.path;
	}

	private async getFile(): Promise<TFile> {
		let f = this.app.vault.getAbstractFileByPath(this.path);
		if (!f) {
			await this.app.vault.create(this.path, "");
			f = this.app.vault.getAbstractFileByPath(this.path);
		}
		if (!(f instanceof TFile)) {
			throw new Error(`Todo.txt path is not a file: ${this.path}`);
		}
		return f;
	}

	private async readLines(): Promise<string[]> {
		const f = await this.getFile();
		const content = await this.app.vault.read(f);
		return content.length ? content.split("\n") : [];
	}

	// Atomic read-modify-write. The transform receives the current lines and
	// returns the new lines, or null to leave the file untouched.
	private async processLines(
		fn: (lines: string[]) => string[] | null
	): Promise<void> {
		const f = await this.getFile();
		await this.app.vault.process(f, (data) => {
			const lines = data.length ? data.split("\n") : [];
			const result = fn(lines);
			return result === null ? data : result.join("\n");
		});
	}

	async readTasks(): Promise<RenderTask[]> {
		const lines = await this.readLines();
		const out: RenderTask[] = [];
		lines.forEach((line, index) => {
			if (line.trim().length === 0) return;
			out.push({ task: parseTask(line), index });
		});
		return out;
	}

	// Best-effort locate: trust the index if the raw line still matches there
	// (fast path), otherwise fall back to a content search (defends against a
	// concurrent external edit having shifted line numbers).
	private locate(lines: string[], rawLine: string, index: number): number {
		if (index >= 0 && index < lines.length && lines[index] === rawLine) {
			return index;
		}
		return lines.indexOf(rawLine);
	}

	async addTask(t: Task): Promise<void> {
		if (!t.creationDate) t.creationDate = todayStr();
		t.text = foldTagsInText(t.text);
		await this.processLines((lines) => {
			lines.push(serializeTask(t));
			return lines;
		});
	}

	// Append several tasks in one atomic write (e.g. a multi-line paste).
	async addTasks(ts: Task[]): Promise<void> {
		if (!ts.length) return;
		for (const t of ts) {
			if (!t.creationDate) t.creationDate = todayStr();
			t.text = foldTagsInText(t.text);
		}
		await this.processLines((lines) => {
			for (const t of ts) lines.push(serializeTask(t));
			return lines;
		});
	}

	async updateTask(rawLine: string, index: number, t: Task): Promise<void> {
		t.text = foldTagsInText(t.text);
		await this.processLines((lines) => {
			const i = this.locate(lines, rawLine, index);
			if (i < 0) return null;
			lines[i] = serializeTask(t);
			return lines;
		});
	}

	async deleteTask(rawLine: string, index: number): Promise<void> {
		await this.processLines((lines) => {
			const i = this.locate(lines, rawLine, index);
			if (i < 0) return null;
			lines.splice(i, 1);
			return lines;
		});
	}

	// Undo a delete: put the line back at its old position (or at the end,
	// if the file has since become shorter).
	async restoreLine(rawLine: string, index: number): Promise<void> {
		await this.processLines((lines) => {
			lines.splice(Math.max(0, Math.min(index, lines.length)), 0, rawLine);
			return lines;
		});
	}

	// Undo an edit: turn the line `fromRaw` back into `toRaw`. Resolves false
	// when `fromRaw` is no longer in the file (it was changed again since).
	async replaceLine(
		fromRaw: string,
		toRaw: string,
		index: number
	): Promise<boolean> {
		let done = false;
		await this.processLines((lines) => {
			const i = this.locate(lines, fromRaw, index);
			done = i >= 0;
			if (i < 0) return null;
			lines[i] = toRaw;
			return lines;
		});
		return done;
	}

	// Undo completing a recurring item: reopen it as it was and remove the
	// occurrence that completing it spawned. Resolves false when the
	// completed line is no longer in the file. A spawned line that has been
	// edited since is left alone rather than guessed at.
	async undoComplete(
		completedRaw: string,
		originalRaw: string,
		spawnedRaw: string | null
	): Promise<boolean> {
		let done = false;
		await this.processLines((lines) => {
			const i = lines.indexOf(completedRaw);
			done = i >= 0;
			if (i < 0) return null;
			lines[i] = originalRaw;
			if (spawnedRaw !== null) {
				// It was inserted directly above; fall back to a search.
				const j =
					i > 0 && lines[i - 1] === spawnedRaw
						? i - 1
						: lines.indexOf(spawnedRaw);
				if (j >= 0) lines.splice(j, 1);
			}
			return lines;
		});
		return done;
	}

	// Toggle completion. Completing a recurring item also spawns the next
	// occurrence (anchored on the original due date) as a new line above it.
	// Resolves with the lines written when an item was completed (so the
	// caller can offer an undo), or null when it was reopened or not found.
	async toggleComplete(
		rawLine: string,
		index: number
	): Promise<{ completedRaw: string; spawnedRaw: string | null } | null> {
		let result: { completedRaw: string; spawnedRaw: string | null } | null =
			null;
		await this.processLines((lines) => {
			result = null;
			const i = this.locate(lines, rawLine, index);
			if (i < 0) return null;
			const t = parseTask(lines[i]);

			if (t.completed) {
				t.completed = false;
				t.completionDate = null;
				lines[i] = serializeTask(t);
				return lines;
			}

			const recurring = !!t.rec;
			const anchor = t.due ?? todayStr();
			t.completed = true;
			t.completionDate = todayStr();
			lines[i] = serializeTask(t);
			result = { completedRaw: lines[i], spawnedRaw: null };

			if (recurring && t.rec) {
				const nd = nextOccurrence(t.rec, anchor);
				if (nd) {
					const next = parseTask(rawLine); // fresh, still-open copy
					next.completed = false;
					next.completionDate = null;
					next.creationDate = todayStr(); // spawned now
					next.due = nd;
					result.spawnedRaw = serializeTask(next);
					lines.splice(i, 0, result.spawnedRaw);
				}
			}
			return lines;
		});
		return result;
	}

	// Move the item to a destination list. For an item in several lists only
	// one tag is swapped — the list it was dragged `from` when it is in it,
	// else its first — and the rest are kept.
	async setProject(
		rawLine: string,
		index: number,
		project: string,
		from?: string | null
	): Promise<void> {
		await this.processLines((lines) => {
			const i = this.locate(lines, rawLine, index);
			if (i < 0) return null;
			const t = parseTask(lines[i]);
			t.projects = replaceProject(t.projects, project, from);
			lines[i] = serializeTask(t);
			return lines;
		});
	}

	// Overwrite the due date to today (used when dragging into Today).
	async setDueToday(rawLine: string, index: number): Promise<void> {
		await this.setDue(rawLine, index, todayStr());
	}

	// Set (or clear, with null) the due date on an item. Resolves with the
	// rewritten line (so the caller can offer an undo), or null if not found.
	async setDue(
		rawLine: string,
		index: number,
		date: string | null
	): Promise<string | null> {
		let written: string | null = null;
		await this.processLines((lines) => {
			const i = this.locate(lines, rawLine, index);
			written = null;
			if (i < 0) return null;
			const t = parseTask(lines[i]);
			t.due = date;
			lines[i] = serializeTask(t);
			written = lines[i];
			return lines;
		});
		return written;
	}

	// Remove a +project tag from every item that has it (items are kept).
	async removeProjectTag(project: string): Promise<void> {
		await this.processLines((lines) => {
			let changed = false;
			for (let i = 0; i < lines.length; i++) {
				if (!lines[i].trim()) continue;
				const t = parseTask(lines[i]);
				if (t.projects.includes(project)) {
					t.projects = t.projects.filter((p) => p !== project);
					lines[i] = serializeTask(t);
					changed = true;
				}
			}
			return changed ? lines : null;
		});
	}

	// Rewrite a +project tag to a new name on every item that has it (items,
	// completed or not, are kept — only the tag spelling changes).
	async renameProjectTag(oldName: string, newName: string): Promise<void> {
		await this.processLines((lines) => {
			let changed = false;
			for (let i = 0; i < lines.length; i++) {
				if (!lines[i].trim()) continue;
				const t = parseTask(lines[i]);
				if (t.projects.includes(oldName)) {
					t.projects = t.projects.map((p) => (p === oldName ? newName : p));
					lines[i] = serializeTask(t);
					changed = true;
				}
			}
			return changed ? lines : null;
		});
	}

	// Permanently delete every line belonging to a +project tag. For the
	// default list, `includeUntagged` also deletes lines with no +project tag,
	// since the view shows those as part of that list.
	async deleteListItems(
		project: string,
		includeUntagged = false
	): Promise<void> {
		await this.processLines((lines) => {
			const kept = lines.filter((line) => {
				if (!line.trim()) return true;
				const { projects } = parseTask(line);
				if (projects.length === 0) return !includeUntagged;
				return !projects.includes(project);
			});
			return kept.length !== lines.length ? kept : null;
		});
	}

	// Permanently delete completed items whose completion date is before
	// `cutoff` (YYYY-MM-DD). Returns how many lines were removed.
	async purgeCompletedBefore(cutoff: string): Promise<number> {
		let removed = 0;
		await this.processLines((lines) => {
			const kept = lines.filter(
				(line) => !line.trim() || !isPurgeable(parseTask(line), cutoff)
			);
			// Assigned, not accumulated: Vault.process may re-run the transform.
			removed = lines.length - kept.length;
			return removed ? kept : null;
		});
		return removed;
	}

	// Append " @tag" to an item's text, unless it already carries that tag
	// (case/diacritic-insensitive). Used when dropping a task onto a rail tag.
	async addTagToTask(
		rawLine: string,
		index: number,
		tagDisplay: string
	): Promise<void> {
		await this.processLines((lines) => {
			const i = this.locate(lines, rawLine, index);
			if (i < 0) return null;
			const t = parseTask(lines[i]);
			const key = tagDisplay.toLowerCase();
			if (extractTaskTags(t.text).some((v) => v.toLowerCase() === key)) {
				return null;
			}
			t.text = `${t.text} @${tagDisplay}`.trim();
			lines[i] = serializeTask(t);
			return lines;
		});
	}

	// Physically reposition a line to sit before/after a target line.
	async reorder(
		srcRaw: string,
		srcIndex: number,
		destRaw: string,
		destIndex: number,
		placeBefore: boolean
	): Promise<void> {
		await this.processLines((lines) => {
			const si = this.locate(lines, srcRaw, srcIndex);
			if (si < 0) return null;
			const [moved] = lines.splice(si, 1);

			const di = this.locate(
				lines,
				destRaw,
				destIndex > si ? destIndex - 1 : destIndex
			);
			if (di < 0) {
				lines.push(moved); // target vanished — append to end
				return lines;
			}
			const insertAt = placeBefore ? di : di + 1;
			lines.splice(insertAt, 0, moved);
			return lines;
		});
	}
}

// Lists are derived by scanning every +project tag; a list survives as long as
// it has at least one line (completed or not). Sorted alphabetically.
export function deriveLists(tasks: RenderTask[]): string[] {
	const set = new Set<string>();
	for (const { task } of tasks) {
		for (const p of task.projects) set.add(p);
	}
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export interface TagInfo {
	key: string; // lowercase ASCII identity
	display: string; // canonical-cased ASCII spelling (most frequent variant)
	incompleteCount: number;
	completedCount: number;
}

// Tags are derived the same way lists are: scan every task's text for
// @tokens. Canonical casing per tag is whichever spelling occurs most often
// in the file (ties broken by first occurrence); existing lines are never
// rewritten to match it. Sorted by incomplete count desc, then completed
// count desc, then alphabetically — the order shared by the rail and the
// suggestion dropdown.
export function deriveTags(tasks: RenderTask[]): TagInfo[] {
	const variantCounts = new Map<string, Map<string, number>>(); // key -> variant -> count
	const firstSeen = new Map<string, number>(); // "key variant" -> order
	const incomplete = new Map<string, number>();
	const completed = new Map<string, number>();
	let order = 0;

	for (const { task } of tasks) {
		for (const variant of extractTaskTags(task.text)) {
			const key = variant.toLowerCase();
			if (!variantCounts.has(key)) variantCounts.set(key, new Map());
			const counts = variantCounts.get(key)!;
			counts.set(variant, (counts.get(variant) ?? 0) + 1);
			const seenKey = key + " " + variant;
			if (!firstSeen.has(seenKey)) firstSeen.set(seenKey, order);
			if (task.completed) completed.set(key, (completed.get(key) ?? 0) + 1);
			else incomplete.set(key, (incomplete.get(key) ?? 0) + 1);
		}
		order++;
	}

	const infos: TagInfo[] = [];
	for (const [key, counts] of variantCounts) {
		let display = key;
		let bestCount = -1;
		let bestOrder = Infinity;
		for (const [variant, count] of counts) {
			const seenOrder = firstSeen.get(key + " " + variant) ?? Infinity;
			if (count > bestCount || (count === bestCount && seenOrder < bestOrder)) {
				display = variant;
				bestCount = count;
				bestOrder = seenOrder;
			}
		}
		infos.push({
			key,
			display,
			incompleteCount: incomplete.get(key) ?? 0,
			completedCount: completed.get(key) ?? 0,
		});
	}

	infos.sort((a, b) => {
		if (b.incompleteCount !== a.incompleteCount) {
			return b.incompleteCount - a.incompleteCount;
		}
		if (b.completedCount !== a.completedCount) {
			return b.completedCount - a.completedCount;
		}
		return humanizeTag(a.display).localeCompare(humanizeTag(b.display));
	});

	return infos;
}
