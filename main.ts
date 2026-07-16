import {
	Notice,
	ObsidianProtocolData,
	Platform,
	Plugin,
	TAbstractFile,
	WorkspaceLeaf,
} from "obsidian";
import { TodoStore, deriveLists, deriveTags } from "./src/store";
import { DEFAULT_SETTINGS, TodoSettings, TodoSettingTab } from "./src/settings";
import { TodoView, VIEW_TYPE_TODO } from "./src/view";
import { TaskModal } from "./src/modal";
import { matchHotkey } from "./src/hotkey";
import { Priority, Task, todayStr } from "./src/todotxt";

// The subset of Electron's remote surface the badge needs, as exposed by
// Obsidian to desktop plugins — window.electron.remote in current builds, or
// window.require("electron").remote in older ones.
interface RemoteElectron {
	remote?: { app?: { dock?: { setBadge?: (text: string) => void } } };
}

interface ElectronWindow extends Window {
	electron?: RemoteElectron;
	require?: (module: string) => RemoteElectron | undefined;
}

// The macOS Dock API. Null anywhere the Dock doesn't exist.
function getDock(): { setBadge: (text: string) => void } | null {
	if (!Platform.isMacOS) return null;
	const w = window as ElectronWindow;
	let remote: RemoteElectron["remote"];
	try {
		remote = w.electron?.remote ?? w.require?.("electron")?.remote;
	} catch {
		return null;
	}
	const dock = remote?.app?.dock;
	const setBadge = dock?.setBadge;
	if (typeof setBadge !== "function") return null;
	return { setBadge: (text: string) => setBadge.call(dock, text) };
}

// Accepts "A"/"B"/"C" (case-insensitive) or the words used in the modal.
function parsePriority(raw: string | undefined): Priority {
	if (!raw) return null;
	const v = raw.trim().toLowerCase();
	if (v === "a" || v === "high") return "A";
	if (v === "b" || v === "med" || v === "medium") return "B";
	if (v === "c" || v === "low") return "C";
	return null;
}

export default class NudgePlugin extends Plugin {
	settings!: TodoSettings;
	store!: TodoStore;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new TodoStore(this.app, this.settings.path);

		this.registerView(
			VIEW_TYPE_TODO,
			(leaf: WorkspaceLeaf) => new TodoView(leaf, this)
		);

		this.addRibbonIcon("list-todo", "Open Nudge", () => {
			void this.activateView();
		});

		this.addRibbonIcon("plus-circle", "New task", () => {
			void this.newTask();
		});

		this.addCommand({
			id: "open-task-list",
			name: "Open task list",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "new-task",
			name: "New task",
			callback: () => void this.newTask(),
		});

		this.addSettingTab(new TodoSettingTab(this.app, this));

		// obsidian://nudge?text=...&list=...&due=YYYY-MM-DD&
		//   priority=high|med|low|A|B|C&link=...&rec=<RRULE>&modal=1
		// With text present it creates the item directly; pass modal=1 (or omit
		// text) to open the prefilled create modal instead.
		this.registerObsidianProtocolHandler("nudge", (params) => {
			void this.handleUri(params);
		});

		// Open and focus the view once the workspace is ready.
		if (this.settings.openOnStartup) {
			this.app.workspace.onLayoutReady(() => void this.activateView());
		}

		// Configurable global shortcut to open the new-task window. Uses a
		// capture-phase listener so it can override Obsidian's own binding for
		// the same combo (e.g. Cmd+N → New note).
		this.registerDomEvent(
			activeDocument,
			"keydown",
			(e: KeyboardEvent) => {
				const hk = this.settings.newItemHotkey;
				if (!hk) return;
				const target = e.target as HTMLElement | null;
				if (target?.closest(".todo-hotkey-input")) return; // recording
				if (!matchHotkey(e, hk)) return;
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				void this.newTask();
			},
			{ capture: true }
		);

		// Re-render open views when the backing file changes on disk (e.g. an
		// external agent rewriting todo.txt).
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file.path === this.store.getPath()) {
					this.refreshViews();
					void this.updateBadge();
				}
			})
		);

		// Badge reflects state even with no Nudge pane open. Deferred to
		// layout-ready so the vault index already knows the file.
		this.app.workspace.onLayoutReady(() => void this.updateBadge());

		// Day rollover: at midnight (or on wake past it) the overdue/due-today
		// populations change even though the file didn't. A cheap minute tick
		// spots the date flip, then refreshes open views and the badge.
		let lastDay = todayStr();
		this.registerInterval(
			window.setInterval(() => {
				const day = todayStr();
				if (day === lastDay) return;
				lastDay = day;
				this.refreshViews();
				void this.updateBadge();
			}, 60_000)
		);
	}

	onunload(): void {
		// Leaves are detached automatically by Obsidian on unload.
		getDock()?.setBadge(""); // don't leave a stale badge behind
	}

	// Recompute the Dock badge: uncompleted tasks that are overdue (or also
	// due today, per settings). Zero, badge disabled, or a read error all
	// clear it — never show a number we can't stand behind.
	async updateBadge(): Promise<void> {
		const dock = getDock();
		if (!dock) return;
		if (!this.settings.dockBadge) {
			dock.setBadge("");
			return;
		}
		let count = 0;
		try {
			const tasks = await this.store.readTasks();
			const today = todayStr();
			const includeToday = this.settings.dockBadgeIncludeToday;
			count = tasks.filter(
				({ task }) =>
					!task.completed &&
					!!task.due &&
					(includeToday ? task.due <= today : task.due < today)
			).length;
		} catch {
			count = 0;
		}
		dock.setBadge(count > 0 ? String(count) : "");
	}

	async handleUri(params: ObsidianProtocolData): Promise<void> {
		const text = (params.text ?? "").trim();
		const list =
			(params.list ?? "").replace(/\s+/g, "") || this.settings.defaultList;
		const prefill: Partial<Task> = {
			text,
			projects: [list],
			due: params.due || null,
			priority: parsePriority(params.priority),
			link: params.link || null,
			rec: params.rec || null,
		};

		const wantsModal = !!params.modal || text.length === 0;
		if (wantsModal) {
			const tasksOnDisk = await this.store.readTasks();
			const lists = deriveLists(tasksOnDisk);
			const tags = deriveTags(tasksOnDisk);
			new TaskModal(this.app, lists, tags, null, list, async (task) => {
				await this.store.addTask(task);
				this.refreshViews();
			}, prefill).open();
			return;
		}

		const task: Task = {
			completed: false,
			completionDate: null,
			creationDate: null, // stamped by the store
			priority: prefill.priority ?? null,
			text,
			projects: [list],
			due: prefill.due ?? null,
			link: prefill.link ?? null,
			rec: prefill.rec ?? null,
			raw: "",
		};
		await this.store.addTask(task);
		new Notice(`Added to ${list}`);
		this.refreshViews();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE_TODO)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_TODO, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	// Open the create modal from anywhere (command / ribbon), independent of
	// whether a view is focused. Presets the list to the active view's
	// selection when it's a real project list.
	async newTask(): Promise<void> {
		const tasks = await this.store.readTasks();
		const lists = deriveLists(tasks);
		const tags = deriveTags(tasks);
		// Preset to the focused view's selected project, else the default list.
		let preset: string | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TODO)) {
			if (leaf.view instanceof TodoView) {
				preset = leaf.view.getSelectedList();
				break;
			}
		}
		if (!preset) preset = this.settings.defaultList;
		new TaskModal(this.app, lists, tags, null, preset, async (task) => {
			await this.store.addTask(task);
			this.refreshViews();
		}).open();
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TODO)) {
			const view = leaf.view;
			if (view instanceof TodoView) void view.refresh();
		}
	}

	onPathChanged(): void {
		this.store.setPath(this.settings.path);
		this.refreshViews();
		void this.updateBadge();
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<TodoSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Clone the styles array/objects so editing them never mutates
		// DEFAULT_SETTINGS (which would leak across reloads).
		this.settings.listStyles = (
			data.listStyles ?? DEFAULT_SETTINGS.listStyles
		).map((s) => ({ ...s }));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
