// Structured create/edit modal. Users never type todo.txt syntax directly.

import { App, Modal, Setting } from "obsidian";
import { humanizeProject, Priority, Task } from "./todotxt";
import {
	RecState,
	RecType,
	WEEKDAY_CODES,
	WEEKDAY_LABELS,
	buildRRule,
	defaultRecState,
	parseRRule,
} from "./recurrence";

const NEW_LIST = "__new__";

// Priority mapping per spec: None / Low=(C) / Med=(B) / High=(A).
const PRIORITY_OPTIONS: { value: string; label: string }[] = [
	{ value: "none", label: "None" },
	{ value: "C", label: "Low" },
	{ value: "B", label: "Med" },
	{ value: "A", label: "High" },
];

export interface TaskModalResult {
	task: Task;
}

export class TaskModal extends Modal {
	private lists: string[];
	private existing: Task | null;
	private onSubmit: (task: Task) => void | Promise<void>;

	// Working field state.
	private text: string;
	private listChoice: string;
	private newListName = "";
	private due: string | null;
	private priority: Priority;
	private link: string | null;
	private rec: RecState;

	private recContainer!: HTMLElement;
	private newListSetting!: Setting;
	private newListInput?: HTMLInputElement;
	private startInNewList: boolean;

	constructor(
		app: App,
		lists: string[],
		existing: Task | null,
		defaultList: string | null,
		onSubmit: (task: Task) => void | Promise<void>,
		prefill?: Partial<Task>,
		startInNewList = false
	) {
		super(app);
		this.lists = lists;
		this.existing = existing;
		this.onSubmit = onSubmit;
		this.startInNewList = startInNewList;

		// `prefill` seeds a *new* item's fields (e.g. from an Obsidian URI); it
		// does not switch the modal into edit mode the way `existing` does.
		this.text = existing?.text ?? prefill?.text ?? "";
		this.due = existing?.due ?? prefill?.due ?? null;
		this.priority = existing?.priority ?? prefill?.priority ?? null;
		this.link = existing?.link ?? prefill?.link ?? null;
		this.rec = existing
			? parseRRule(existing.rec)
			: prefill?.rec
				? parseRRule(prefill.rec)
				: defaultRecState();

		const firstProject =
			existing?.projects[0] ?? prefill?.projects?.[0] ?? defaultList ?? "";
		this.listChoice = firstProject && lists.includes(firstProject)
			? firstProject
			: firstProject
				? firstProject // preserve even if not yet in derived lists
				: lists[0] ?? NEW_LIST;
		if (this.listChoice === NEW_LIST) this.newListName = "";

		// Force the "New list…" branch when opened via the new-list affordance,
		// regardless of any existing/prefilled project.
		if (startInNewList) {
			this.listChoice = NEW_LIST;
			this.newListName = "";
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: this.existing ? "Edit task" : "New task",
		});

		new Setting(contentEl).setName("Text").addText((t) =>
			t
				.setValue(this.text)
				.setPlaceholder("What needs doing?")
				.onChange((v) => (this.text = v))
		);

		// List dropdown (existing lists + "New list…").
		new Setting(contentEl).setName("List").addDropdown((d) => {
			const known = new Set(this.lists);
			for (const l of this.lists) d.addOption(l, humanizeProject(l));
			// Preserve an existing project even if it isn't in the derived set.
			if (this.listChoice !== NEW_LIST && !known.has(this.listChoice)) {
				d.addOption(this.listChoice, humanizeProject(this.listChoice));
			}
			d.addOption(NEW_LIST, "New list…");
			d.setValue(this.listChoice);
			d.onChange((v) => {
				this.listChoice = v;
				this.newListSetting.settingEl.toggle(v === NEW_LIST);
			});
		});

		this.newListSetting = new Setting(contentEl)
			.setName("New list name")
			.addText((t) => {
				this.newListInput = t.inputEl;
				t
					.setValue(this.newListName)
					.setPlaceholder("ProjectName")
					.onChange((v) => (this.newListName = v.replace(/\s+/g, "")));
			});
		this.newListSetting.settingEl.toggle(this.listChoice === NEW_LIST);

		new Setting(contentEl).setName("Due date").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(this.due ?? "");
			t.onChange((v) => (this.due = v || null));
		});

		new Setting(contentEl).setName("Priority").addDropdown((d) => {
			for (const o of PRIORITY_OPTIONS) d.addOption(o.value, o.label);
			d.setValue(this.priority ?? "none");
			d.onChange((v) => (this.priority = v === "none" ? null : (v as Priority)));
		});

		new Setting(contentEl).setName("Link").addText((t) => {
			t.inputEl.type = "url";
			t.setPlaceholder("https://…");
			t.setValue(this.link ?? "");
			t.onChange((v) => (this.link = v || null));
		});

		// Recurrence picker.
		new Setting(contentEl).setName("Recurrence").addDropdown((d) => {
			const types: { value: RecType; label: string }[] = [
				{ value: "none", label: "None" },
				{ value: "daily", label: "Daily" },
				{ value: "weekly", label: "Weekly" },
				{ value: "monthly", label: "Monthly" },
				{ value: "workdays", label: "Custom workdays" },
				{ value: "nth", label: "Nth weekday of month" },
			];
			for (const t of types) d.addOption(t.value, t.label);
			d.setValue(this.rec.type);
			d.onChange((v) => {
				this.rec.type = v as RecType;
				this.renderRecControls();
			});
		});

		this.recContainer = contentEl.createDiv({ cls: "todo-rec-controls" });
		this.renderRecControls();

		// Action buttons.
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(this.existing ? "Save" : "Add")
					.setCta()
					.onClick(() => this.submit())
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

		// Opened via the new-list affordance: drop the cursor straight into the
		// list-name field.
		if (this.startInNewList) {
			window.setTimeout(() => this.newListInput?.focus(), 0);
		}
	}

	private renderRecControls(): void {
		const c = this.recContainer;
		c.empty();
		const type = this.rec.type;

		if (type === "daily" || type === "weekly" || type === "monthly") {
			const unit = type === "daily" ? "days" : type === "weekly" ? "weeks" : "months";
			new Setting(c).setName(`Every N ${unit}`).addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.setValue(String(this.rec.interval));
				t.onChange((v) => (this.rec.interval = Math.max(1, Number(v) || 1)));
			});
		}

		if (type === "weekly") {
			const s = new Setting(c).setName("On days");
			for (const code of WEEKDAY_CODES) {
				const label = s.controlEl.createEl("label", { cls: "todo-weekday" });
				const cb = label.createEl("input", { type: "checkbox" });
				cb.checked = this.rec.weekdays.includes(code);
				cb.addEventListener("change", () => {
					if (cb.checked) {
						if (!this.rec.weekdays.includes(code)) this.rec.weekdays.push(code);
					} else {
						this.rec.weekdays = this.rec.weekdays.filter((w) => w !== code);
					}
				});
				label.appendText(WEEKDAY_LABELS[code]);
			}
		}

		if (type === "nth") {
			new Setting(c).setName("Which").addDropdown((d) => {
				const opts: { value: string; label: string }[] = [
					{ value: "1", label: "First" },
					{ value: "2", label: "Second" },
					{ value: "3", label: "Third" },
					{ value: "4", label: "Fourth" },
					{ value: "-1", label: "Last" },
				];
				for (const o of opts) d.addOption(o.value, o.label);
				d.setValue(String(this.rec.nth));
				d.onChange((v) => (this.rec.nth = Number(v)));
			});
			new Setting(c).setName("Weekday").addDropdown((d) => {
				for (const code of WEEKDAY_CODES) d.addOption(code, WEEKDAY_LABELS[code]);
				d.setValue(this.rec.nthWeekday);
				d.onChange((v) => (this.rec.nthWeekday = v));
			});
		}
	}

	private submit(): void {
		const text = this.text.trim();
		if (!text) {
			this.flash("Text is required.");
			return;
		}
		const project =
			this.listChoice === NEW_LIST ? this.newListName.trim() : this.listChoice;
		if (!project) {
			this.flash("A list is required.");
			return;
		}

		const task: Task = {
			completed: this.existing?.completed ?? false,
			completionDate: this.existing?.completionDate ?? null,
			creationDate: this.existing?.creationDate ?? null,
			priority: this.priority,
			text,
			projects: [project],
			due: this.due,
			link: this.link,
			rec: buildRRule(this.rec),
			raw: this.existing?.raw ?? "",
		};

		void this.onSubmit(task);
		this.close();
	}

	private flash(msg: string): void {
		let el = this.contentEl.querySelector<HTMLElement>(".todo-modal-error");
		if (!el) {
			el = this.contentEl.createDiv({ cls: "todo-modal-error" });
		}
		el.setText(msg);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Confirmation for deleting a list, with three choices. Cancel is the default;
// Enter and Esc both cancel and close.
export class DeleteListModal extends Modal {
	constructor(
		app: App,
		private listName: string,
		private onRemoveTag: () => void | Promise<void>,
		private onDeleteAll: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: `Delete list "${humanizeProject(this.listName)}"?`,
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "This can't be undone in-app — rely on Obsidian's file history to recover.",
		});

		const row = new Setting(contentEl);
		let cancelBtn: HTMLElement | null = null;
		row.addButton((b) => {
			b.setButtonText("Cancel").onClick(() => this.close());
			cancelBtn = b.buttonEl;
		});
		row.addButton((b) => {
			b.setButtonText("Remove tag from items").onClick(async () => {
				await this.onRemoveTag();
				this.close();
			});
			b.buttonEl.addClass("mod-warning");
		});
		row.addButton((b) => {
			b.setButtonText("Delete all items").onClick(async () => {
				await this.onDeleteAll();
				this.close();
			});
			b.buttonEl.addClass("mod-warning");
		});

		// Enter cancels too (Esc already closes the modal by default).
		contentEl.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					e.stopPropagation();
					this.close();
				}
			},
			{ capture: true }
		);

		(cancelBtn as HTMLElement | null)?.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
