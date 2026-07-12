// File-backed store. There is no long-lived cache: every operation reads the
// file fresh, applies one change, and writes it back — keeping the race window
// for external edits to milliseconds (see SPEC.md § Concurrency).

import { App, TFile } from "obsidian";
import { parseTask, serializeTask, Task, todayStr } from "./todotxt";
import { nextOccurrence } from "./recurrence";

export interface RenderTask {
	task: Task;
	index: number; // physical line index in the file
}

export class TodoStore {
	constructor(private app: App, private path: string) {}

	setPath(p: string): void {
		this.path = p;
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

	private async writeLines(lines: string[]): Promise<void> {
		const f = await this.getFile();
		await this.app.vault.modify(f, lines.join("\n"));
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
		const lines = await this.readLines();
		lines.push(serializeTask(t));
		await this.writeLines(lines);
	}

	async updateTask(rawLine: string, index: number, t: Task): Promise<void> {
		const lines = await this.readLines();
		const i = this.locate(lines, rawLine, index);
		if (i < 0) return;
		lines[i] = serializeTask(t);
		await this.writeLines(lines);
	}

	async deleteTask(rawLine: string, index: number): Promise<void> {
		const lines = await this.readLines();
		const i = this.locate(lines, rawLine, index);
		if (i < 0) return;
		lines.splice(i, 1);
		await this.writeLines(lines);
	}

	// Toggle completion. Completing a recurring item also spawns the next
	// occurrence (anchored on the original due date) as a new line above it.
	async toggleComplete(rawLine: string, index: number): Promise<void> {
		const lines = await this.readLines();
		const i = this.locate(lines, rawLine, index);
		if (i < 0) return;
		const t = parseTask(lines[i]);

		if (t.completed) {
			t.completed = false;
			t.completionDate = null;
			lines[i] = serializeTask(t);
			await this.writeLines(lines);
			return;
		}

		const recurring = !!t.rec;
		const anchor = t.due ?? todayStr();
		t.completed = true;
		t.completionDate = todayStr();
		lines[i] = serializeTask(t);

		if (recurring && t.rec) {
			const nd = nextOccurrence(t.rec, anchor);
			if (nd) {
				const next = parseTask(rawLine); // fresh, still-open copy
				next.completed = false;
				next.completionDate = null;
				next.creationDate = todayStr(); // spawned now
				next.due = nd;
				lines.splice(i, 0, serializeTask(next));
			}
		}
		await this.writeLines(lines);
	}

	// Rewrite the item's project membership to a single destination list.
	async setProject(rawLine: string, index: number, project: string): Promise<void> {
		const lines = await this.readLines();
		const i = this.locate(lines, rawLine, index);
		if (i < 0) return;
		const t = parseTask(lines[i]);
		t.projects = [project];
		lines[i] = serializeTask(t);
		await this.writeLines(lines);
	}

	// Overwrite the due date to today (used when dragging into Today).
	async setDueToday(rawLine: string, index: number): Promise<void> {
		await this.setDue(rawLine, index, todayStr());
	}

	// Set (or clear, with null) the due date on an item.
	async setDue(
		rawLine: string,
		index: number,
		date: string | null
	): Promise<void> {
		const lines = await this.readLines();
		const i = this.locate(lines, rawLine, index);
		if (i < 0) return;
		const t = parseTask(lines[i]);
		t.due = date;
		lines[i] = serializeTask(t);
		await this.writeLines(lines);
	}

	// Remove a +project tag from every item that has it (items are kept).
	async removeProjectTag(project: string): Promise<void> {
		const lines = await this.readLines();
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
		if (changed) await this.writeLines(lines);
	}

	// Permanently delete every line belonging to a +project tag.
	async deleteListItems(project: string): Promise<void> {
		const lines = await this.readLines();
		const kept = lines.filter(
			(line) => !line.trim() || !parseTask(line).projects.includes(project)
		);
		if (kept.length !== lines.length) await this.writeLines(kept);
	}

	// Physically reposition a line to sit before/after a target line.
	async reorder(
		srcRaw: string,
		srcIndex: number,
		destRaw: string,
		destIndex: number,
		placeBefore: boolean
	): Promise<void> {
		const lines = await this.readLines();
		const si = this.locate(lines, srcRaw, srcIndex);
		if (si < 0) return;
		const [moved] = lines.splice(si, 1);

		let di = this.locate(lines, destRaw, destIndex > si ? destIndex - 1 : destIndex);
		if (di < 0) {
			// Target vanished — append to end.
			lines.push(moved);
			await this.writeLines(lines);
			return;
		}
		const insertAt = placeBefore ? di : di + 1;
		lines.splice(insertAt, 0, moved);
		await this.writeLines(lines);
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
