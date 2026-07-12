import { App, PluginSettingTab, Setting, getIconIds } from "obsidian";
import type NudgePlugin from "../main";
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
	openOnStartup: boolean;
	listStyles: ListStyle[];
}

export const DEFAULT_SETTINGS: TodoSettings = {
	path: "todo.txt",
	defaultList: "Inbox",
	newItemHotkey: "",
	openOnStartup: true,
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
			.setName("New task hotkey")
			.setDesc(
				"Shortcut to open the new-task window from anywhere. Click the field and press the combination; press Backspace to clear. Overrides Obsidian's default binding for that combo."
			)
			.addText((text) => {
				text.inputEl.addClass("todo-hotkey-input");
				text.inputEl.readOnly = true;
				text.setPlaceholder("Press keys…");
				text.setValue(hotkeyToDisplay(this.plugin.settings.newItemHotkey));
				text.inputEl.addEventListener("keydown", (e) => {
					e.preventDefault();
					if (e.key === "Backspace" || e.key === "Delete") {
						this.plugin.settings.newItemHotkey = "";
					} else if (isModifierOnly(e)) {
						return; // wait for a real key
					} else {
						this.plugin.settings.newItemHotkey = eventToHotkey(e);
					}
					void (async () => {
						await this.plugin.saveSettings();
						text.setValue(
							hotkeyToDisplay(this.plugin.settings.newItemHotkey)
						);
						text.inputEl.blur();
					})();
				});
			});

		this.renderListStyles(containerEl);
	}

	private renderListStyles(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("List styles")
			.setDesc(
				'Give a list a custom color and icon. Matched by name ignoring spaces and case (e.g. "Home Chores" matches HomeChores).'
			)
			.setHeading();

		// Shared datalist of icon ids for the icon inputs.
		const datalistId = "todo-icon-datalist";
		const datalist = containerEl.createEl("datalist");
		datalist.id = datalistId;
		for (const id of getIconIds()) {
			datalist.createEl("option", { value: id });
		}

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
			row.addText((t) => {
				t.setPlaceholder("icon (e.g. star)")
					.setValue(style.icon)
					.onChange(async (v) => {
						style.icon = v.trim();
						preview.setIcon(style.icon || "list");
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					});
				t.inputEl.setAttribute("list", datalistId);
			});
			let preview!: import("obsidian").ExtraButtonComponent;
			row.addExtraButton((b) => {
				preview = b;
				b.setIcon(style.icon || "list").setTooltip("Icon preview");
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
