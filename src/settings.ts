import { App, PluginSettingTab, Setting } from "obsidian";
import type NudgePlugin from "../main";
import { IconPickerModal } from "./iconPicker";
import {
	eventToHotkey,
	hotkeyToDisplay,
	isModifierOnly,
} from "./hotkey";

// A per-list color + icon override, matched by name ignoring spaces/case.
export interface ListStyle {
	name: string;
	color: string; // hex, e.g. "#4caf50"
	icon: string; // an icon id (see getIconIds())
}

export interface TodoSettings {
	path: string;
	defaultList: string; // pre-selected list for new items; always pinned
	newItemHotkey: string; // normalized hotkey, e.g. "Meta+N"; "" disables
	searchHotkey: string; // opens search while the view is active; "" disables
	openOnStartup: boolean;
	showCompletedToday: boolean; // if off, tasks hide as soon as they're completed
	dockBadge: boolean; // macOS Dock badge with a task count
	dockBadgeIncludeToday: boolean; // badge also counts tasks due today
	listStyles: ListStyle[];
}

export const DEFAULT_SETTINGS: TodoSettings = {
	path: "todo.txt",
	defaultList: "Inbox",
	newItemHotkey: "",
	searchHotkey: "",
	openOnStartup: true,
	showCompletedToday: true,
	dockBadge: false,
	dockBadgeIncludeToday: true,
	listStyles: [
		{ name: "Today", color: "#4a90e2", icon: "calendar-clock" },
		{ name: "Inbox", color: "#43a047", icon: "inbox" },
	],
};

export class TodoSettingTab extends PluginSettingTab {
	plugin: NudgePlugin;

	constructor(app: App, plugin: NudgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.render();
	}

	// Own render entry point so internal re-renders (after adding/removing a
	// list style) don't call the framework's display() directly.
	private render(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Todo.txt file path")
			.setDesc("Vault-relative path to the todo.txt file backing this plugin.")
			.addText((text) =>
				text
					.setPlaceholder("todo.txt")
					.setValue(this.plugin.settings.path)
					.onChange(async (value) => {
						this.plugin.settings.path = value.trim() || "todo.txt";
						await this.plugin.saveSettings();
						this.plugin.onPathChanged();
					})
			);

		new Setting(containerEl)
			.setName("Default list")
			.setDesc(
				"List pre-selected when creating a new task. Always pinned in the sidebar (second, under Today) even when it has no items."
			)
			.addText((text) =>
				text
					.setPlaceholder("Inbox")
					.setValue(this.plugin.settings.defaultList)
					.onChange(async (value) => {
						this.plugin.settings.defaultList =
							value.replace(/\s+/g, "") || "Inbox";
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName("Open on startup")
			.setDesc("Open and focus the Nudge view when Obsidian starts.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
					this.plugin.settings.openOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show tasks completed today")
			.setDesc(
				"When off, a task disappears from its list as soon as it's marked complete (still recoverable via the eye toggle)."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showCompletedToday)
					.onChange(async (v) => {
						this.plugin.settings.showCompletedToday = v;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName("Dock badge (macOS)")
			.setDesc(
				"Show the native red badge on Obsidian's Dock icon with the number of overdue tasks."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.dockBadge).onChange(async (v) => {
					this.plugin.settings.dockBadge = v;
					await this.plugin.saveSettings();
					void this.plugin.updateBadge();
				})
			);

		new Setting(containerEl)
			.setName("Badge includes tasks due today")
			.setDesc(
				"Count tasks due today alongside overdue ones, matching the Today view. When off, the badge counts only overdue tasks."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.dockBadgeIncludeToday)
					.onChange(async (v) => {
						this.plugin.settings.dockBadgeIncludeToday = v;
						await this.plugin.saveSettings();
						void this.plugin.updateBadge();
					})
			);

		this.hotkeySetting(
			containerEl,
			"New task hotkey",
			"Shortcut to open the new-task window from anywhere. Click the field and press the combination; press Backspace to clear. Overrides Obsidian's default binding for that combo.",
			() => this.plugin.settings.newItemHotkey,
			(v) => (this.plugin.settings.newItemHotkey = v)
		);

		this.hotkeySetting(
			containerEl,
			"Search hotkey",
			"Shortcut to open search while the Nudge view is active. Click the field and press the combination; press Backspace to clear. Overrides Obsidian's default binding for that combo (e.g. find-in-note for Cmd+F).",
			() => this.plugin.settings.searchHotkey,
			(v) => (this.plugin.settings.searchHotkey = v)
		);

		this.renderListStyles(containerEl);
	}

	// A click-and-press hotkey recorder bound to one settings field.
	private hotkeySetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		get: () => string,
		set: (v: string) => void
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.addClass("todo-hotkey-input");
				text.inputEl.readOnly = true;
				text.setPlaceholder("Press keys…");
				text.setValue(hotkeyToDisplay(get()));
				text.inputEl.addEventListener("keydown", (e) => {
					e.preventDefault();
					if (e.key === "Backspace" || e.key === "Delete") {
						set("");
					} else if (isModifierOnly(e)) {
						return; // wait for a real key
					} else {
						set(eventToHotkey(e));
					}
					void (async () => {
						await this.plugin.saveSettings();
						text.setValue(hotkeyToDisplay(get()));
						text.inputEl.blur();
					})();
				});
			});
	}

	private renderListStyles(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("List styles")
			.setDesc(
				'Give a list a custom color and icon. Matched by name ignoring spaces and case (e.g. "Home Chores" matches HomeChores).'
			)
			.setHeading();

		const styles = this.plugin.settings.listStyles;
		styles.forEach((style, i) => {
			const row = new Setting(containerEl);
			row.addText((t) =>
				t
					.setPlaceholder("List name")
					.setValue(style.name)
					.onChange(async (v) => {
						style.name = v;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);
			row.addColorPicker((c) =>
				c.setValue(style.color || "#888888").onChange(async (v) => {
					style.color = v;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				})
			);
			row.addExtraButton((b) => {
				const show = (icon: string) => {
					// setIcon appends; clear first so picks don't stack.
					b.extraSettingsEl.empty();
					b.setIcon(icon).setTooltip(`Icon: ${icon} — click to change`);
				};
				show(style.icon || "list");
				b.onClick(() => {
					new IconPickerModal(this.app, (icon) => {
						style.icon = icon;
						show(icon);
						void (async () => {
							await this.plugin.saveSettings();
							this.plugin.refreshViews();
						})();
					}).open();
				});
			});
			row.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip("Remove")
					.onClick(async () => {
						styles.splice(i, 1);
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
						this.render();
					})
			);
		});

		new Setting(containerEl).addButton((b) =>
			b.setButtonText("Add list style").onClick(async () => {
				styles.push({ name: "", color: "#888888", icon: "list" });
				await this.plugin.saveSettings();
				this.render();
			})
		);
	}
}
