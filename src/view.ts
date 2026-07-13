import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type NudgePlugin from "../main";
import { RenderTask, deriveLists } from "./store";
import {
	humanizeProject,
	inToday,
	isPastDue,
	isVisible,
	normalizeListName,
	parseTask,
	todayStr,
	Task,
} from "./todotxt";
import { TaskModal, DeleteListModal } from "./modal";
import type { ListStyle } from "./settings";

export const VIEW_TYPE_TODO = "nudge-view";
const TODAY = " today"; // sentinel; sorts/handles distinctly from real lists

// Brand marks shown in place of the generic link icon for recognized services.
const GITHUB_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const SLACK_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 122.8 122.8" width="16" height="16" aria-hidden="true"><path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A"/><path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0"/><path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D"/><path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E"/><path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E"/></svg>';

// Parse a trusted static SVG string into a DOM node (avoids innerHTML).
function appendSvg(el: HTMLElement, markup: string): void {
	const svg = new DOMParser().parseFromString(markup, "image/svg+xml")
		.documentElement;
	el.empty();
	el.appendChild(svg);
}

// Swap the generic link glyph for a recognized service's logo. Returns the
// accessible label to use for the button.
function setLinkIcon(el: HTMLElement, url: string): string {
	const u = url.toLowerCase();
	if (u.includes("github.com")) {
		appendSvg(el, GITHUB_SVG);
		return "Open on GitHub";
	}
	if (u.includes("slack.com")) {
		appendSvg(el, SLACK_SVG);
		return "Open in Slack";
	}
	setIcon(el, "link");
	return "Open link";
}

interface DragState {
	raw: string;
	index: number;
}

export class TodoView extends ItemView {
	private plugin: NudgePlugin;
	private selected: string = TODAY;
	private drag: DragState | null = null;
	private showCompleted = false; // reveal items completed before today
	private todayFilterList: string | null = null; // filter Today to one list
	private todayFilterPriority: string | null = null; // filter Today to one priority
	private adding = false; // inline add-row is active (input focused)
	private editing: { raw: string; index: number } | null = null; // item under inline text edit
	private rendering = false; // true only during a synchronous re-render

	private railEl!: HTMLElement;
	private panelEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: NudgePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TODO;
	}

	getDisplayText(): string {
		return "Nudge";
	}

	getIcon(): string {
		return "list-todo";
	}

	// The selected project list, or null when Today is selected.
	getSelectedList(): string | null {
		return this.selected === TODAY ? null : this.selected;
	}

	// Configured color/icon override for a list, matched ignoring spaces/case.
	private styleFor(list: string): ListStyle | undefined {
		const key = normalizeListName(list);
		return this.plugin.settings.listStyles.find(
			(s) => s.name && normalizeListName(s.name) === key
		);
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("todo-root");
		this.railEl = root.createDiv({ cls: "todo-rail" });
		this.panelEl = root.createDiv({ cls: "todo-panel" });
		await this.refresh();
	}

	async refresh(): Promise<void> {
		let tasks: RenderTask[];
		try {
			tasks = await this.plugin.store.readTasks();
		} catch (e) {
			this.panelEl.empty();
			this.panelEl.createDiv({ cls: "todo-empty", text: String(e) });
			return;
		}
		const today = todayStr();
		const defaultList = this.plugin.settings.defaultList;
		const lists = deriveLists(tasks);

		// If the selected project list no longer exists, fall back to Today.
		// The default list is always valid even when it has no items.
		if (
			this.selected !== TODAY &&
			this.selected !== defaultList &&
			!lists.includes(this.selected)
		) {
			this.selected = TODAY;
		}

		// `rendering` is true only across this synchronous render. Emptying the
		// panel removes any focused inline input, which fires a phantom `blur`;
		// the blur handlers check this flag to tell that apart from a real
		// user-initiated blur (which only ever happens while not rendering).
		this.rendering = true;
		try {
			this.renderRail(tasks, lists, today);
			this.renderPanel(tasks, today);
		} finally {
			this.rendering = false;
		}
	}

	private renderRail(tasks: RenderTask[], lists: string[], today: string): void {
		this.railEl.empty();
		const defaultList = this.plugin.settings.defaultList;

		// Counts show only uncompleted tasks.
		const listCount = (name: string) =>
			tasks.filter(
				(rt) => rt.task.projects.includes(name) && !rt.task.completed
			).length;

		const showCompletedToday = this.plugin.settings.showCompletedToday;
		const todayCount = tasks.filter(
			(rt) => inToday(rt.task, today, showCompletedToday) && !rt.task.completed
		).length;
		const stToday = this.styleFor(TODAY); // normalizes to "today"
		this.railEl.appendChild(
			this.railItem(
				TODAY,
				"Today",
				todayCount,
				stToday?.icon || "calendar-clock",
				stToday?.color
			)
		);

		// Default list pinned second, always shown (even with zero items).
		if (defaultList) {
			const st = this.styleFor(defaultList);
			this.railEl.appendChild(
				this.railItem(
					defaultList,
					humanizeProject(defaultList),
					listCount(defaultList),
					st?.icon || "inbox",
					st?.color
				)
			);
		}

		for (const list of lists) {
			if (list === defaultList) continue; // already pinned above
			const st = this.styleFor(list);
			this.railEl.appendChild(
				this.railItem(
					list,
					humanizeProject(list),
					listCount(list),
					st?.icon || "list",
					st?.color
				)
			);
		}

		this.railEl.appendChild(this.newListTile());
	}

	// Bottom-of-rail affordance for creating a list. Since lists are purely
	// derived from +project tags, a new list is born by seeding it with a real
	// item: clicking opens the create modal on "New list…"; dropping an existing
	// task opens its edit modal on "New list…" to reassign it.
	private newListTile(): HTMLElement {
		const el = createDiv({ cls: "todo-rail-item todo-rail-newlist" });
		const ic = el.createSpan({ cls: "todo-rail-icon" });
		setIcon(ic, "folder-plus");
		el.createSpan({ cls: "todo-rail-label", text: "New list" });

		el.addEventListener("click", () => void this.openCreateNewList());

		el.addEventListener("dragover", (e) => {
			if (this.drag) {
				e.preventDefault();
				el.addClass("is-drop");
			}
		});
		el.addEventListener("dragleave", () => el.removeClass("is-drop"));
		el.addEventListener("drop", (e) => {
			e.preventDefault();
			el.removeClass("is-drop");
			const d = this.drag;
			this.drag = null;
			if (!d) return;
			void this.openEditNewList(d.raw, d.index);
		});

		return el;
	}

	private railItem(
		key: string,
		label: string,
		count: number,
		icon: string,
		color?: string
	): HTMLElement {
		const el = createDiv({ cls: "todo-rail-item" });
		if (key === this.selected) el.addClass("is-active");
		const ic = el.createSpan({ cls: "todo-rail-icon" });
		setIcon(ic, icon);
		if (color) ic.style.color = color;
		el.createSpan({ cls: "todo-rail-label", text: label });
		el.createSpan({ cls: "todo-rail-count", text: String(count) });

		el.addEventListener("click", () => {
			this.selected = key;
			this.adding = false;
			this.editing = null;
			void this.refresh();
		});

		// Drop target: onto a list rewrites project; onto Today sets due=today.
		el.addEventListener("dragover", (e) => {
			if (this.drag) {
				e.preventDefault();
				el.addClass("is-drop");
			}
		});
		el.addEventListener("dragleave", () => el.removeClass("is-drop"));
		el.addEventListener("drop", (e) => {
			e.preventDefault();
			el.removeClass("is-drop");
			const d = this.drag;
			this.drag = null;
			if (!d) return;
			void (async () => {
				if (key === TODAY) {
					await this.plugin.store.setDueToday(d.raw, d.index);
				} else {
					await this.plugin.store.setProject(d.raw, d.index, key);
				}
				await this.refresh();
			})();
		});

		return el;
	}

	private renderPanel(tasks: RenderTask[], today: string): void {
		this.panelEl.empty();
		const isToday = this.selected === TODAY;

		// Membership of a task in the current view, ignoring completion state.
		const belongs = (rt: RenderTask) =>
			isToday
				? !!rt.task.due && rt.task.due <= today
				: rt.task.projects.includes(this.selected);

		// In Today, optional list/priority filters narrow both groups below.
		const matchesFilter = (rt: RenderTask) =>
			!isToday ||
			((!this.todayFilterList ||
				rt.task.projects.includes(this.todayFilterList)) &&
				(!this.todayFilterPriority ||
					rt.task.priority === this.todayFilterPriority));

		const showCompletedToday = this.plugin.settings.showCompletedToday;

		// Top group: active + completed-today (if shown), in file order.
		const shown = isToday
			? tasks.filter(
					(rt) =>
						inToday(rt.task, today, showCompletedToday) && matchesFilter(rt)
			  )
			: tasks.filter(
					(rt) => belongs(rt) && isVisible(rt.task, today, showCompletedToday)
			  );

		// Past group: completed on an earlier day (or today, if today's
		// completions are hidden from the top group), freshest first.
		const past = this.showCompleted
			? tasks
					.filter(
						(rt) =>
							belongs(rt) &&
							matchesFilter(rt) &&
							rt.task.completed &&
							!!rt.task.completionDate &&
							(rt.task.completionDate < today ||
								(!showCompletedToday && rt.task.completionDate === today))
					)
					.sort((a, b) =>
						(b.task.completionDate ?? "").localeCompare(
							a.task.completionDate ?? ""
						)
					)
			: [];

		const header = this.panelEl.createDiv({ cls: "todo-header" });
		const left = header.createDiv({ cls: "todo-header-left" });

		const st = this.styleFor(isToday ? TODAY : this.selected);
		const defaultIcon = isToday
			? "calendar-clock"
			: this.selected === this.plugin.settings.defaultList
				? "inbox"
				: "list";
		const icon = left.createSpan({ cls: "todo-header-icon" });
		setIcon(icon, st?.icon || defaultIcon);
		if (st?.color) icon.style.color = st.color;

		left.createEl("h3", {
			text: isToday ? "Today" : humanizeProject(this.selected),
		});

		// Toggle to reveal/hide items completed on an earlier day.
		const eye = left.createSpan({ cls: "todo-eye" });
		setIcon(eye, this.showCompleted ? "eye-off" : "eye");
		eye.setAttr(
			"aria-label",
			this.showCompleted ? "Hide past completed" : "Show past completed"
		);
		eye.addEventListener("click", () => {
			this.showCompleted = !this.showCompleted;
			void this.refresh();
		});

		// Active list filter for Today: click anywhere on it to clear.
		if (isToday && this.todayFilterList) {
			const filterList = this.todayFilterList;
			const pill = left.createSpan({ cls: "todo-list-tag todo-filter-pill" });
			const fst = this.styleFor(filterList);
			if (fst?.icon) {
				const ic = pill.createSpan({ cls: "todo-list-tag-icon" });
				setIcon(ic, fst.icon);
				if (fst.color) ic.style.color = fst.color;
			}
			pill.createSpan({ text: humanizeProject(filterList) });
			if (fst?.color) pill.style.borderColor = fst.color;
			const x = pill.createSpan({ cls: "todo-list-tag-icon" });
			setIcon(x, "x");
			pill.setAttr("aria-label", `Clear filter: ${humanizeProject(filterList)}`);
			pill.addEventListener("click", () => {
				this.todayFilterList = null;
				void this.refresh();
			});
		}

		// Active priority filter for Today: click anywhere on it to clear.
		if (isToday && this.todayFilterPriority) {
			const pri = this.todayFilterPriority;
			const pill = left.createSpan({
				cls: `todo-pri todo-pri-${pri} todo-filter-pill`,
			});
			pill.createSpan({ text: pri });
			const x = pill.createSpan({ cls: "todo-list-tag-icon" });
			setIcon(x, "x");
			pill.setAttr("aria-label", `Clear priority filter: ${pri}`);
			pill.addEventListener("click", () => {
				this.todayFilterPriority = null;
				void this.refresh();
			});
		}

		// Delete-list icon (project lists only; Today can't be deleted).
		if (!isToday) {
			const list = this.selected;
			const del = left.createSpan({ cls: "todo-trash" });
			setIcon(del, "trash-2");
			del.setAttr("aria-label", "Delete list");
			del.addEventListener("click", () => {
				new DeleteListModal(
					this.app,
					list,
					async () => {
						await this.plugin.store.removeProjectTag(list);
						await this.refresh();
					},
					async () => {
						await this.plugin.store.deleteListItems(list);
						await this.refresh();
					}
				).open();
			});
		}

		// Copy the currently visible items (respects filters/showCompleted).
		const copyList = left.createSpan({ cls: "todo-copy-list" });
		setIcon(copyList, "clipboard-list");
		copyList.setAttr("aria-label", "Copy list");
		copyList.addEventListener("click", (e) => {
			const visible = [...shown, ...past];
			if (visible.length === 0) {
				new Notice("Nothing to copy");
				return;
			}
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Plain text").onClick(() => {
					this.copyVisible(visible, (rt) =>
						rt.task.link
							? `${rt.task.text}: ${rt.task.link}`
							: rt.task.text
					);
				})
			);
			menu.addItem((item) =>
				item.setTitle("Markdown checklist").onClick(() => {
					this.copyVisible(visible, (rt) => {
						const text = rt.task.link
							? `[${rt.task.text}](${rt.task.link})`
							: rt.task.text;
						return `- [${rt.task.completed ? "x" : " "}] ${text}`;
					});
				})
			);
			menu.addItem((item) =>
				item.setTitle("Todo.txt syntax").onClick(() => {
					this.copyVisible(visible, (rt) => rt.task.raw);
				})
			);
			menu.showAtMouseEvent(e);
		});

		// Add button on every view: focuses the inline add-row rather than
		// opening a modal.
		const add = header.createEl("button", { cls: "todo-add-btn" });
		setIcon(add, "plus");
		add.setAttr("aria-label", "New task");
		add.addEventListener("click", () => this.activateAdd());

		const listEl = this.panelEl.createDiv({ cls: "todo-list" });
		for (const rt of shown) {
			listEl.appendChild(this.renderItem(rt, today, isToday));
		}
		// Permanent add-row at the bottom of the active group. Doubles as the
		// empty state, so there's no separate "Nothing here." message.
		listEl.appendChild(this.renderAddRow());
		if (past.length) {
			const pastEl = listEl.createDiv({ cls: "todo-past" });
			for (const rt of past) {
				pastEl.appendChild(this.renderItem(rt, today, isToday));
			}
		}
	}

	// Enter inline-add mode and re-render so the add-row shows a focused input.
	private activateAdd(): void {
		this.editing = null;
		this.adding = true;
		void this.refresh();
	}

	// The project a new inline-added task should join, per view context.
	private newTaskProject(): string {
		if (this.selected !== TODAY) return this.selected;
		return this.todayFilterList ?? this.plugin.settings.defaultList;
	}

	private renderAddRow(): HTMLElement {
		const row = createDiv({ cls: "todo-item todo-add-row" });
		const cb = row.createEl("input", { type: "checkbox", cls: "todo-check" });
		cb.checked = false;
		cb.tabIndex = -1;
		const main = row.createDiv({ cls: "todo-item-main" });

		if (!this.adding) {
			main.createSpan({ cls: "todo-text todo-add-placeholder", text: "Add task" });
			row.addEventListener("click", () => this.activateAdd());
			return row;
		}

		const input = main.createEl("input", {
			type: "text",
			cls: "todo-text-input",
		});
		input.placeholder = "Add task";
		let done = false;
		const commit = (keepAdding: boolean): void => {
			if (done) return;
			const text = input.value.trim();
			if (!text) {
				done = true;
				this.adding = false;
				void this.refresh();
				return;
			}
			done = true;
			const isToday = this.selected === TODAY;
			const task: Task = {
				completed: false,
				completionDate: null,
				creationDate: null,
				priority: null,
				text,
				projects: [this.newTaskProject()],
				due: isToday ? todayStr() : null,
				link: null,
				rec: null,
				raw: "",
			};
			void (async () => {
				await this.plugin.store.addTask(task);
				this.adding = keepAdding;
				await this.refresh();
			})();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				done = true; // suppress the blur that the re-render triggers
				this.adding = false;
				void this.refresh();
			}
		});
		input.addEventListener("blur", () => {
			// Ignore the phantom blur fired when a re-render detaches the input;
			// only a real user-initiated blur leaves it connected.
			if (this.rendering || !input.isConnected) return;
			commit(false);
		});
		window.setTimeout(() => input.focus(), 0);
		return row;
	}

	private renderItem(
		rt: RenderTask,
		today: string,
		showList: boolean
	): HTMLElement {
		const t = rt.task;
		const row = createDiv({ cls: "todo-item" });
		if (t.completed) row.addClass("is-completed");
		row.setAttr("draggable", "true");

		// Single click toggles completion instantly. Clicks on the checkbox and
		// action buttons are ignored here (they have their own handlers). Edit
		// is reached via the pencil button.
		row.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest("input, button")) return;
			void (async () => {
				await this.plugin.store.toggleComplete(rt.task.raw, rt.index);
				await this.refresh();
			})();
		});

		// Checkbox.
		const cb = row.createEl("input", {
			type: "checkbox",
			cls: "todo-check",
		});
		cb.checked = t.completed;
		cb.addEventListener("change", () => {
			void (async () => {
				await this.plugin.store.toggleComplete(rt.task.raw, rt.index);
				await this.refresh();
			})();
		});

		if (t.priority) {
			const pri = row.createSpan({
				cls: `todo-pri todo-pri-${t.priority}`,
				text: t.priority,
			});
			if (showList) {
				const priority = t.priority;
				pri.addClass("is-clickable");
				pri.addEventListener("click", (e) => {
					e.stopPropagation();
					this.todayFilterPriority =
						this.todayFilterPriority === priority ? null : priority;
					void this.refresh();
				});
			}
		}

		const main = row.createDiv({ cls: "todo-item-main" });
		const isEditing =
			!!this.editing &&
			this.editing.raw === t.raw &&
			this.editing.index === rt.index;
		if (isEditing) {
			const input = main.createEl("input", {
				type: "text",
				cls: "todo-text-input",
			});
			input.value = t.text;
			let done = false;
			const commit = (): void => {
				if (done) return;
				done = true;
				const newText = input.value.trim();
				this.editing = null;
				if (!newText || newText === t.text) {
					void this.refresh(); // empty or unchanged: revert
					return;
				}
				void (async () => {
					await this.plugin.store.updateTask(t.raw, rt.index, {
						...t,
						text: newText,
					});
					await this.refresh();
				})();
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					done = true; // suppress the blur that the re-render triggers
					this.editing = null;
					void this.refresh();
				}
			});
			input.addEventListener("blur", () => {
				// Ignore the phantom blur fired when a re-render detaches the
				// input; only a real user-initiated blur leaves it connected.
				if (this.rendering || !input.isConnected) return;
				commit();
			});
			window.setTimeout(() => {
				input.focus();
				input.select();
			}, 0);
		} else {
			// Clicking the text starts inline editing; completion toggling stays
			// on the checkbox / blank row space (stopPropagation avoids the row
			// handler here).
			const textSpan = main.createSpan({ cls: "todo-text", text: t.text });
			textSpan.addEventListener("click", (e) => {
				e.stopPropagation();
				this.adding = false;
				this.editing = { raw: t.raw, index: rt.index };
				void this.refresh();
			});
		}

		const meta = main.createDiv({ cls: "todo-meta" });
		// In Today, show the originating list(s) to the left of the due date,
		// one pill each so per-list colors/icons apply.
		if (showList) {
			for (const project of t.projects) {
				const tag = meta.createSpan({ cls: "todo-list-tag" });
				const st = this.styleFor(project);
				if (st?.icon) {
					const ic = tag.createSpan({ cls: "todo-list-tag-icon" });
					setIcon(ic, st.icon);
					if (st.color) ic.style.color = st.color;
				}
				tag.createSpan({ text: humanizeProject(project) });
				if (st?.color) tag.style.borderColor = st.color;
				tag.addEventListener("click", (e) => {
					e.stopPropagation();
					this.todayFilterList =
						this.todayFilterList === project ? null : project;
					void this.refresh();
				});
			}
		}
		if (t.due) {
			const wrap = meta.createSpan({ cls: "todo-due-wrap" });
			const due = wrap.createSpan({ cls: "todo-due", text: t.due });
			if (isPastDue(t, today)) due.addClass("is-overdue");
			// Clicking the date opens a native picker that writes back on change.
			const picker = wrap.createEl("input", {
				type: "date",
				cls: "todo-due-input",
			});
			picker.value = t.due;
			due.addEventListener("click", (e) => {
				e.stopPropagation();
				if (typeof picker.showPicker === "function") picker.showPicker();
				else picker.focus();
			});
			picker.addEventListener("click", (e) => e.stopPropagation());
			picker.addEventListener("change", (e) => {
				e.stopPropagation();
				if (!picker.value) return;
				void (async () => {
					await this.plugin.store.setDue(t.raw, rt.index, picker.value);
					await this.refresh();
				})();
			});
		}
		if (t.rec) {
			const r = meta.createSpan({ cls: "todo-rec" });
			setIcon(r, "repeat");
		}

		// Right-side actions.
		const actions = row.createDiv({ cls: "todo-actions" });
		if (t.link) {
			const link = actions.createEl("button", {
				cls: "todo-action todo-link",
			});
			const label = setLinkIcon(link, t.link);
			link.setAttr("aria-label", label);
			link.addEventListener("click", (e) => {
				e.stopPropagation();
				window.open(t.link!, "_blank");
			});
		}
		const copy = actions.createEl("button", { cls: "todo-action todo-hover" });
		setIcon(copy, "clipboard-copy");
		copy.setAttr("aria-label", "Copy text");
		copy.addEventListener("click", (e) => {
			e.stopPropagation();
			void navigator.clipboard.writeText(
				t.link ? `${t.text}: ${t.link}` : t.text
			);
		});

		const edit = actions.createEl("button", { cls: "todo-action todo-hover" });
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "Edit");
		edit.addEventListener("click", () => {
			void this.openEdit(rt);
		});

		const del = actions.createEl("button", { cls: "todo-action todo-hover" });
		setIcon(del, "trash-2");
		del.setAttr("aria-label", "Delete");
		del.addEventListener("click", () => {
			void (async () => {
				await this.plugin.store.deleteTask(rt.task.raw, rt.index);
				await this.refresh();
			})();
		});

		// Drag to reorder.
		row.addEventListener("dragstart", (e) => {
			this.drag = { raw: rt.task.raw, index: rt.index };
			row.addClass("is-dragging");
			e.dataTransfer?.setData("text/plain", rt.task.raw);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		});
		row.addEventListener("dragend", () => {
			row.removeClass("is-dragging");
			this.drag = null;
		});
		row.addEventListener("dragover", (e) => {
			if (this.drag && this.drag.index !== rt.index) {
				e.preventDefault();
				const rect = row.getBoundingClientRect();
				const before = e.clientY < rect.top + rect.height / 2;
				row.toggleClass("drop-before", before);
				row.toggleClass("drop-after", !before);
			}
		});
		row.addEventListener("dragleave", () => {
			row.removeClass("drop-before");
			row.removeClass("drop-after");
		});
		row.addEventListener("drop", (e) => {
			e.preventDefault();
			const before = row.hasClass("drop-before");
			row.removeClass("drop-before");
			row.removeClass("drop-after");
			const d = this.drag;
			this.drag = null;
			if (!d || d.index === rt.index) return;
			void (async () => {
				await this.plugin.store.reorder(
					d.raw,
					d.index,
					rt.task.raw,
					rt.index,
					before
				);
				await this.refresh();
			})();
		});

		return row;
	}

	private copyVisible(
		visible: RenderTask[],
		format: (rt: RenderTask) => string
	): void {
		void navigator.clipboard.writeText(visible.map(format).join("\n"));
		new Notice(`Copied ${visible.length} item${visible.length === 1 ? "" : "s"} to clipboard`);
	}

	// New-list tile, click path: create a brand-new task with the modal opened
	// on "New list…" and the name field focused.
	private async openCreateNewList(): Promise<void> {
		const tasks = await this.plugin.store.readTasks();
		const lists = deriveLists(tasks);
		new TaskModal(
			this.app,
			lists,
			null,
			null,
			async (task) => {
				await this.plugin.store.addTask(task);
				await this.refresh();
			},
			undefined,
			true
		).open();
	}

	// New-list tile, drop path: reassign the dropped task by opening its edit
	// modal on "New list…" so the user names the destination list.
	private async openEditNewList(raw: string, index: number): Promise<void> {
		const tasks = await this.plugin.store.readTasks();
		const lists = deriveLists(tasks);
		const task = parseTask(raw);
		new TaskModal(
			this.app,
			lists,
			task,
			null,
			async (updated) => {
				await this.plugin.store.updateTask(raw, index, updated);
				await this.refresh();
			},
			undefined,
			true
		).open();
	}

	private async openEdit(rt: RenderTask): Promise<void> {
		const tasks = await this.plugin.store.readTasks();
		const lists = deriveLists(tasks);
		new TaskModal(this.app, lists, rt.task, null, async (task) => {
			await this.plugin.store.updateTask(rt.task.raw, rt.index, task);
			await this.refresh();
		}).open();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}
}
