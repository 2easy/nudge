import {
	ItemView,
	Menu,
	Notice,
	WorkspaceLeaf,
	prepareFuzzySearch,
	setIcon,
} from "obsidian";
import type NudgePlugin from "../main";
import { RenderTask, TagInfo, deriveLists, deriveTags } from "./store";
import {
	asciiFold,
	extractTaskTags,
	humanizeProject,
	humanizeTag,
	inToday,
	isPastDue,
	isVisible,
	normalizeListName,
	parseTask,
	TAG_TOKEN_RE,
	tagMatchesQuery,
	todayStr,
	Task,
} from "./todotxt";
import { TaskModal, DeleteListModal } from "./modal";
import { matchHotkey } from "./hotkey";
import { attachTagSuggest, TagSuggestHandle } from "./tagSuggest";
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

// Fuzzy search kicks in at 2 characters: a 1-char subsequence query matches
// nearly every item, so anything shorter keeps showing the previous view.
const MIN_SEARCH_CHARS = 2;

// A fuzzy-search match: relevance score plus where it landed, for highlighting.
interface SearchHit {
	rt: RenderTask;
	score: number;
	ranges: [number, number][]; // matched char ranges within task.text
	linkMatched: boolean; // some match fell in the cleaned link
}

// Reduce a URL to searchable words: strip the protocol and "www.", drop the
// query string and fragment, percent-decode, and break on separators — so a
// slug like /how-to-paint-blood-angels matches the query "blood angels".
function cleanLink(link: string): string {
	let s = link
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^www\./i, "");
	const cut = s.search(/[?#]/);
	if (cut >= 0) s = s.slice(0, cut);
	try {
		s = decodeURIComponent(s);
	} catch {
		// Malformed percent-escapes: search the raw form instead.
	}
	return s.replace(/[/\-_.]+/g, " ").trim();
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
	private searchActive = false; // header search input is expanded
	private searchQuery = "";
	private searchShowCompleted = true; // Results' own eye state (default: shown)
	private searchJustOpened = false; // animate the widening on the next render
	private searchTagSuggest?: TagSuggestHandle;
	private searchTagJustCommitted = false; // suppress dropdown reopen after a tag pick

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

		// Configurable search hotkey (unset by default), honored only while
		// this view is the active pane; capture phase so it wins over
		// Obsidian's own binding for the combo (e.g. find-in-note for Cmd+F).
		this.registerDomEvent(
			activeDocument,
			"keydown",
			(e: KeyboardEvent) => {
				const hk = this.plugin.settings.searchHotkey;
				if (!hk) return;
				const target = e.target as HTMLElement | null;
				if (target?.closest(".todo-hotkey-input")) return; // recording
				if (!matchHotkey(e, hk)) return;
				if (this.app.workspace.getActiveViewOfType(TodoView) !== this)
					return;
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				this.openSearch();
			},
			{ capture: true }
		);

		// Esc closes search from anywhere in the view — except inside an
		// inline add/edit input (which handles its own Esc), a modal above, or
		// while a tag-suggestion dropdown is open (first Esc closes that instead).
		this.registerDomEvent(activeDocument, "keydown", (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !this.searchActive) return;
			if (this.app.workspace.getActiveViewOfType(TodoView) !== this) return;
			const target = e.target as HTMLElement | null;
			if (
				target?.closest(
					".todo-text-input, .modal-container, .todo-tag-suggest-active"
				)
			)
				return;
			e.preventDefault();
			this.closeSearch();
			void this.refresh();
		});

		await this.refresh();
	}

	// True when search is active with a long-enough query to filter by.
	private searching(): boolean {
		return (
			this.searchActive &&
			this.searchQuery.trim().length >= MIN_SEARCH_CHARS
		);
	}

	private openSearch(): void {
		if (this.searchActive) {
			// Already open (Cmd+F again): refocus, selecting the query.
			const input = this.panelEl.querySelector<HTMLInputElement>(
				"input.todo-search-input"
			);
			input?.focus();
			input?.select();
			return;
		}
		this.searchActive = true;
		this.searchQuery = "";
		this.searchShowCompleted = true; // finding old items is the point
		this.searchJustOpened = true;
		this.adding = false;
		this.editing = null;
		void this.refresh();
	}

	// Reset search state; callers refresh. `selected` is never touched by
	// search, so the panel falls straight back to the previous view.
	private closeSearch(): void {
		this.searchActive = false;
		this.searchQuery = "";
		this.searchJustOpened = false;
	}

	// Opens search pre-filled to a tag's @-mode query. Used by both the rail
	// tag rows and clicking an inline @tag token in item text.
	private openTagSearch(tagVariant: string): void {
		this.searchActive = true;
		this.searchQuery = "@" + tagVariant;
		this.searchShowCompleted = true;
		this.searchJustOpened = true;
		this.adding = false;
		this.editing = null;
		void this.refresh();
	}

	// The @-mode tag key of the current search query, or null when search
	// isn't in tag mode — used to highlight the matching rail row.
	private activeTagKey(): string | null {
		if (!this.searching()) return null;
		const q = this.searchQuery.trim();
		if (!q.startsWith("@")) return null;
		const key = asciiFold(q.slice(1)).toLowerCase();
		return key || null;
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
		const tags = deriveTags(tasks);

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
			this.renderRail(tasks, lists, tags, today);
			this.renderPanel(tasks, tags, today);
		} finally {
			this.rendering = false;
		}
	}

	private renderRail(
		tasks: RenderTask[],
		lists: string[],
		tags: TagInfo[],
		today: string
	): void {
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

		// @tags, below a separator: incomplete-count desc, hidden once a tag
		// has no incomplete items left (still findable in search/suggestions).
		const visibleTags = tags.filter((t) => t.incompleteCount > 0);
		if (visibleTags.length) {
			this.railEl.appendChild(createDiv({ cls: "todo-rail-sep" }));
			const activeKey = this.activeTagKey();
			for (const info of visibleTags) {
				this.railEl.appendChild(this.tagRailItem(info, activeKey));
			}
		}
	}

	private tagRailItem(info: TagInfo, activeKey: string | null): HTMLElement {
		const el = createDiv({ cls: "todo-rail-item todo-rail-tag" });
		if (activeKey === info.key) el.addClass("is-active");
		const ic = el.createSpan({ cls: "todo-rail-icon" });
		setIcon(ic, "at-sign");
		el.createSpan({ cls: "todo-rail-label", text: humanizeTag(info.display) });
		el.createSpan({ cls: "todo-rail-count", text: String(info.incompleteCount) });

		el.addEventListener("click", () => {
			this.openTagSearch(info.display);
		});

		// Drop target: append the tag to the dropped task's text.
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
				await this.plugin.store.addTagToTask(d.raw, d.index, info.display);
				await this.refresh();
			})();
		});

		return el;
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
			this.closeSearch(); // navigating away ends an open search
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

	private renderPanel(tasks: RenderTask[], tags: TagInfo[], today: string): void {
		// Capture the search input's focus/caret before the re-render destroys
		// it, so typing survives the full rebuild without the cursor jumping.
		const prevSearch = this.panelEl.querySelector<HTMLInputElement>(
			"input.todo-search-input"
		);
		const searchCaret =
			prevSearch && prevSearch.ownerDocument.activeElement === prevSearch
				? prevSearch.selectionStart
				: null;
		const activeEl = this.panelEl.ownerDocument.activeElement;
		const focusWasInPanel = !!activeEl && this.panelEl.contains(activeEl);
		const justOpened = this.searchJustOpened;
		this.searchJustOpened = false;

		this.panelEl.empty();
		const isSearch = this.searching();
		const isToday = this.selected === TODAY;

		const hits = new Map<RenderTask, SearchHit>();
		let shown: RenderTask[];
		let past: RenderTask[];

		const rawQuery = this.searchQuery.trim();
		const tagQuery =
			isSearch && rawQuery.startsWith("@") ? rawQuery.slice(1) : null;

		if (isSearch && tagQuery !== null) {
			// @-mode: exact tag membership (word-prefix match) rather than fuzzy
			// text search. Incomplete on top in file order, completed below
			// newest-first — same grouping as a normal browsing view, not score.
			const belongs = (rt: RenderTask) =>
				extractTaskTags(rt.task.text).some((v) => tagMatchesQuery(v, tagQuery));
			shown = tasks.filter((rt) => belongs(rt) && !rt.task.completed);
			past = this.searchShowCompleted
				? tasks
						.filter((rt) => belongs(rt) && rt.task.completed)
						.sort((a, b) =>
							(b.task.completionDate ?? "").localeCompare(
								a.task.completionDate ?? ""
							)
						)
				: [];
		} else if (isSearch) {
			// Every item in the file is a candidate, regardless of list, due
			// date, or completion age. Corpus per item: text + cleaned link.
			const fuzzy = prepareFuzzySearch(this.searchQuery.trim());
			const scored: SearchHit[] = [];
			for (const rt of tasks) {
				const t = rt.task;
				const corpus = t.link
					? `${t.text} ${cleanLink(t.link)}`
					: t.text;
				const m = fuzzy(corpus);
				if (!m) continue;
				const len = t.text.length;
				const ranges: [number, number][] = [];
				let linkMatched = false;
				for (const [start, end] of m.matches) {
					if (start < len) ranges.push([start, Math.min(end, len)]);
					if (end > len + 1) linkMatched = true;
				}
				scored.push({ rt, score: m.score, ranges, linkMatched });
			}
			scored.sort((a, b) => b.score - a.score); // best match first
			for (const h of scored) hits.set(h.rt, h);
			shown = scored
				.filter((h) => !h.rt.task.completed)
				.map((h) => h.rt);
			// All completed matches — including completed-today — live in the
			// bottom section, still in score order.
			past = this.searchShowCompleted
				? scored.filter((h) => h.rt.task.completed).map((h) => h.rt)
				: [];
		} else {
			// Membership of a task in the current view, ignoring completion.
			const belongs = (rt: RenderTask) =>
				isToday
					? !!rt.task.due && rt.task.due <= today
					: rt.task.projects.includes(this.selected);

			// In Today, optional list/priority filters narrow both groups.
			const matchesFilter = (rt: RenderTask) =>
				!isToday ||
				((!this.todayFilterList ||
					rt.task.projects.includes(this.todayFilterList)) &&
					(!this.todayFilterPriority ||
						rt.task.priority === this.todayFilterPriority));

			const showCompletedToday = this.plugin.settings.showCompletedToday;

			// Top group: active + completed-today (if shown), in file order.
			shown = isToday
				? tasks.filter(
						(rt) =>
							inToday(rt.task, today, showCompletedToday) &&
							matchesFilter(rt)
				  )
				: tasks.filter(
						(rt) =>
							belongs(rt) &&
							isVisible(rt.task, today, showCompletedToday)
				  );

			// Past group: completed on an earlier day (or today, if today's
			// completions are hidden from the top group), freshest first.
			past = this.showCompleted
				? tasks
						.filter(
							(rt) =>
								belongs(rt) &&
								matchesFilter(rt) &&
								rt.task.completed &&
								!!rt.task.completionDate &&
								(rt.task.completionDate < today ||
									(!showCompletedToday &&
										rt.task.completionDate === today))
						)
						.sort((a, b) =>
							(b.task.completionDate ?? "").localeCompare(
								a.task.completionDate ?? ""
							)
						)
				: [];
		}

		const header = this.panelEl.createDiv({ cls: "todo-header" });
		const left = header.createDiv({ cls: "todo-header-left" });

		const st = isSearch
			? undefined
			: this.styleFor(isToday ? TODAY : this.selected);
		const defaultIcon = isSearch
			? "search"
			: isToday
				? "calendar-clock"
				: this.selected === this.plugin.settings.defaultList
					? "inbox"
					: "list";
		const icon = left.createSpan({ cls: "todo-header-icon" });
		setIcon(icon, st?.icon || defaultIcon);
		if (st?.color) icon.style.color = st.color;

		left.createEl("h3", {
			text: isSearch
				? "Results"
				: isToday
					? "Today"
					: humanizeProject(this.selected),
		});

		// Toggle to reveal/hide completed items. Results keeps its own toggle
		// state (default: shown), independent of the browsing views'.
		const eyeOn = isSearch ? this.searchShowCompleted : this.showCompleted;
		const eye = left.createSpan({ cls: "todo-eye" });
		setIcon(eye, eyeOn ? "eye-off" : "eye");
		eye.setAttr(
			"aria-label",
			isSearch
				? eyeOn
					? "Hide completed"
					: "Show completed"
				: eyeOn
					? "Hide past completed"
					: "Show past completed"
		);
		eye.addEventListener("click", () => {
			if (isSearch) this.searchShowCompleted = !this.searchShowCompleted;
			else this.showCompleted = !this.showCompleted;
			void this.refresh();
		});

		// Active list filter for Today: click anywhere on it to clear.
		if (!isSearch && isToday && this.todayFilterList) {
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
		if (!isSearch && isToday && this.todayFilterPriority) {
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

		// Delete-list icon (project lists only; Today/Results can't be deleted).
		if (!isSearch && !isToday) {
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

		const right = header.createDiv({ cls: "todo-header-right" });
		this.renderSearchControl(right, justOpened, tags);

		// Add button on every view: focuses the inline add-row rather than
		// opening a modal. From Results it first exits back to the previous
		// view (see activateAdd).
		const add = right.createEl("button", { cls: "todo-add-btn" });
		setIcon(add, "plus");
		add.setAttr("aria-label", "New task");
		add.addEventListener("click", () => this.activateAdd());

		const listEl = this.panelEl.createDiv({ cls: "todo-list" });
		for (const rt of shown) {
			listEl.appendChild(
				this.renderItem(rt, today, isSearch || isToday, tags, hits.get(rt))
			);
		}
		if (isSearch) {
			// No add-row in Results (there's no list for a new task to join),
			// so an explicit empty state stands in for it.
			if (shown.length === 0 && past.length === 0) {
				listEl.createDiv({ cls: "todo-empty", text: "No matching items" });
			}
		} else {
			// Permanent add-row at the bottom of the active group. Doubles as
			// the empty state, so there's no separate "Nothing here." message.
			listEl.appendChild(this.renderAddRow(tags));
		}
		if (past.length) {
			const pastEl = listEl.createDiv({ cls: "todo-past" });
			for (const rt of past) {
				pastEl.appendChild(
					this.renderItem(rt, today, isSearch || isToday, tags, hits.get(rt))
				);
			}
		}

		// Restore search-input focus after re-renders triggered by typing or
		// by interactions inside this panel — never steal it from other panes
		// (external file edits re-render this view too).
		if (
			this.searchActive &&
			!this.adding &&
			!this.editing &&
			(justOpened || searchCaret !== null || focusWasInPanel)
		) {
			const input = this.panelEl.querySelector<HTMLInputElement>(
				"input.todo-search-input"
			);
			if (input) {
				input.focus();
				const caret = searchCaret ?? input.value.length;
				input.setSelectionRange(caret, caret);
				// The search input is torn down and rebuilt on every keystroke, so
				// the tag-suggest dropdown needs an explicit resync here — its own
				// native "input" event fired on the element that just got replaced.
				if (this.searchTagJustCommitted) {
					this.searchTagJustCommitted = false;
				} else {
					this.searchTagSuggest?.sync();
				}
			}
		}
	}

	// The magnifying-glass circle that widens into the query input, plus the
	// in-input clear button. Lives left of the + button in the header.
	private renderSearchControl(
		parent: HTMLElement,
		justOpened: boolean,
		tags: TagInfo[]
	): void {
		const search = parent.createSpan({ cls: "todo-search" });
		const icon = search.createSpan({ cls: "todo-search-icon" });
		setIcon(icon, "search");

		if (!this.searchActive) {
			this.searchTagSuggest = undefined;
			search.addClass("is-collapsed");
			search.setAttr("aria-label", "Search");
			search.addEventListener("click", () => this.openSearch());
			return;
		}

		const input = search.createEl("input", {
			type: "text",
			cls: "todo-search-input",
		});
		input.placeholder = "Search";
		input.value = this.searchQuery;
		this.searchTagSuggest = attachTagSuggest(input, parent, () => tags, {
			onCommit: () => {
				this.searchTagJustCommitted = true;
			},
		});
		input.addEventListener("input", () => {
			this.searchQuery = input.value;
			void this.refresh();
		});
		input.addEventListener("blur", () => {
			// Ignore the phantom blur fired when a re-render detaches the
			// input; only a real user-initiated blur leaves it connected.
			if (this.rendering || !input.isConnected) return;
			if (input.value.trim().length) return; // keep results usable
			// Collapse an abandoned empty input — but deferred, so the click
			// that caused the blur lands on live elements first (a sync
			// re-render here would destroy the click's target before mouseup).
			window.setTimeout(() => {
				if (!this.searchActive || this.searchQuery.trim().length) return;
				if (
					input.isConnected &&
					input.ownerDocument.activeElement === input
				)
					return; // got refocused
				this.closeSearch();
				void this.refresh();
			}, 250);
		});

		const clear = search.createSpan({ cls: "todo-search-clear" });
		setIcon(clear, "x");
		clear.setAttr("aria-label", "Clear search");
		// Keep the input from blurring first, so the click stays simple.
		clear.addEventListener("mousedown", (e) => e.preventDefault());
		clear.addEventListener("click", () => {
			this.closeSearch();
			void this.refresh();
		});

		// Mount collapsed on the opening render, then widen a frame later so
		// the CSS transition animates the open — and only the open, not every
		// keystroke's re-render.
		if (justOpened) {
			search.addClass("is-collapsed");
			window.requestAnimationFrame(() => {
				search.removeClass("is-collapsed");
				search.addClass("is-open");
			});
		} else {
			search.addClass("is-open");
		}
	}

	// Enter inline-add mode and re-render so the add-row shows a focused input.
	// From Results this first closes search, so the add happens back in the
	// previously selected view where the new task will be visible.
	private activateAdd(): void {
		this.closeSearch();
		this.editing = null;
		this.adding = true;
		void this.refresh();
	}

	// The project a new inline-added task should join, per view context.
	private newTaskProject(): string {
		if (this.selected !== TODAY) return this.selected;
		return this.todayFilterList ?? this.plugin.settings.defaultList;
	}

	private renderAddRow(tags: TagInfo[]): HTMLElement {
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
		// Attached before the Enter/Escape handling below, so a keystroke
		// consumed by an open suggestion dropdown never also submits/cancels.
		attachTagSuggest(input, main, () => tags);
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
		showList: boolean,
		tags: TagInfo[],
		search?: SearchHit
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
			// Click-to-filter is a Today affordance; in Results it's inert.
			if (showList && !search) {
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
			// Attached before the Enter/Escape handling below, so a keystroke
			// consumed by an open suggestion dropdown never also submits/cancels.
			attachTagSuggest(input, main, () => tags);
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
			const textSpan = main.createSpan({ cls: "todo-text" });
			const text = t.text;
			const ranges = search?.ranges ?? [];

			// Highlight the fuzzy-matched characters within [from, to), so
			// scattered subsequence hits don't look arbitrary.
			const appendPlain = (from: number, to: number): void => {
				if (from >= to) return;
				let pos = from;
				for (const [s, e] of ranges) {
					const cs = Math.max(s, from);
					const ce = Math.min(e, to);
					if (cs >= ce) continue;
					if (cs > pos) textSpan.appendText(text.slice(pos, cs));
					textSpan.createSpan({
						cls: "todo-search-match",
						text: text.slice(cs, ce),
					});
					pos = ce;
				}
				if (pos < to) textSpan.appendText(text.slice(pos, to));
			};

			// @tag tokens always render as capitalized, spaced, clickable
			// tokens; a fuzzy match that overlaps one highlights the whole
			// token rather than a partial slice of it (word-spacing means
			// character offsets no longer line up 1:1 once split).
			let pos = 0;
			for (const m of text.matchAll(TAG_TOKEN_RE)) {
				const start = m.index ?? 0;
				const end = start + m[0].length;
				appendPlain(pos, start);
				const variant = asciiFold(m[1]);
				const tagHit = ranges.some(([s, e]) => s < end && e > start);
				const tagEl = textSpan.createSpan({
					cls: "todo-inline-tag" + (tagHit ? " todo-search-match" : ""),
					text: "@" + humanizeTag(variant),
				});
				tagEl.addEventListener("click", (e) => {
					e.stopPropagation();
					this.openTagSearch(variant);
				});
				pos = end;
			}
			appendPlain(pos, text.length);

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
					if (search) {
						// Jump to the list this result lives in, ending search.
						this.closeSearch();
						this.selected = project;
						this.adding = false;
						this.editing = null;
						void this.refresh();
						return;
					}
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
			// Same highlight as matched text: signals the query hit the URL.
			if (search?.linkMatched) link.addClass("todo-search-match-link");
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

		// Drag to reorder. Dragging out of Results to a rail target still
		// works, but rows there aren't drop targets themselves: reordering a
		// score-sorted view is meaningless.
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
		if (!search) {
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
		}

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
		const tags = deriveTags(tasks);
		new TaskModal(
			this.app,
			lists,
			tags,
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
		const tags = deriveTags(tasks);
		const task = parseTask(raw);
		new TaskModal(
			this.app,
			lists,
			tags,
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
		const tags = deriveTags(tasks);
		new TaskModal(this.app, lists, tags, rt.task, null, async (task) => {
			await this.plugin.store.updateTask(rt.task.raw, rt.index, task);
			await this.refresh();
		}).open();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}
}
