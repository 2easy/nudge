import { Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { TodoStore, deriveLists } from "./src/store";
import { DEFAULT_SETTINGS, TodoSettings, TodoSettingTab } from "./src/settings";
import { TodoView, VIEW_TYPE_TODO } from "./src/view";
import { TaskModal } from "./src/modal";
import { matchHotkey } from "./src/hotkey";

export default class TodoTxtRemindersPlugin extends Plugin {
	settings!: TodoSettings;
	store!: TodoStore;
	private keepOpen = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new TodoStore(this.app, this.settings.path);

		this.registerView(
			VIEW_TYPE_TODO,
			(leaf: WorkspaceLeaf) => new TodoView(leaf, this)
		);

		this.addRibbonIcon("list-todo", "Open Todo.txt Reminders", () => {
			void this.activateView();
		});

		this.addRibbonIcon("plus-circle", "New reminder", () => {
			void this.newReminder();
		});

		this.addCommand({
			id: "open-todo-txt-reminders",
			name: "Open Todo.txt Reminders",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "new-todo-txt-reminder",
			name: "New reminder",
			callback: () => void this.newReminder(),
		});

		this.addSettingTab(new TodoSettingTab(this.app, this));

		// Keep the view effectively unclosable: once it has been open, reopen
		// it immediately if it gets closed.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (
					this.keepOpen &&
					this.app.workspace.getLeavesOfType(VIEW_TYPE_TODO).length === 0
				) {
					void this.activateView();
				}
			})
		);

		// Configurable global shortcut to open the new-reminder window. Uses a
		// capture-phase listener so it can override Obsidian's own binding for
		// the same combo (e.g. Cmd+N → New note).
		this.registerDomEvent(
			document,
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
				void this.newReminder();
			},
			{ capture: true }
		);

		// Re-render open views when the backing file changes on disk (e.g. an
		// external agent rewriting todo.txt).
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file.path === this.settings.path) this.refreshViews();
			})
		);
	}

	onunload(): void {
		// Leaves are detached automatically by Obsidian on unload.
	}

	markViewOpen(): void {
		this.keepOpen = true;
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE_TODO)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_TODO, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	// Open the create modal from anywhere (command / ribbon), independent of
	// whether a view is focused. Presets the list to the active view's
	// selection when it's a real project list.
	async newReminder(): Promise<void> {
		const tasks = await this.store.readTasks();
		const lists = deriveLists(tasks);
		// Preset to the focused view's selected project, else the default list.
		let preset: string | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TODO)) {
			if (leaf.view instanceof TodoView) {
				preset = leaf.view.getSelectedList();
				break;
			}
		}
		if (!preset) preset = this.settings.defaultList;
		new TaskModal(this.app, lists, null, preset, async (task) => {
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
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
