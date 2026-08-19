// Searchable picker over every icon Obsidian has registered (the built-in
// lucide set plus anything other plugins added). The list-style rows in
// settings used to take an icon id through a plain text input backed by a
// <datalist>, which never showed its options — clicking the field looked
// like a dead control.

import { App, FuzzyMatch, FuzzySuggestModal, getIconIds, setIcon } from "obsidian";

// Built-in ids come back prefixed ("lucide-star"); the prefix is noise when
// searching and when shown next to the glyph.
function iconLabel(id: string): string {
	return id.startsWith("lucide-") ? id.slice("lucide-".length) : id;
}

export class IconPickerModal extends FuzzySuggestModal<string> {
	private readonly onPick: (icon: string) => void;

	constructor(app: App, onPick: (icon: string) => void) {
		super(app);
		this.onPick = onPick;
		this.limit = 100;
		this.setPlaceholder("Search icons…");
	}

	getItems(): string[] {
		// Some ids are registered both bare and prefixed; one entry each.
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const id of getIconIds()) {
			const label = iconLabel(id);
			if (seen.has(label)) continue;
			seen.add(label);
			ids.push(id);
		}
		return ids.sort((a, b) => iconLabel(a).localeCompare(iconLabel(b)));
	}

	getItemText(id: string): string {
		return iconLabel(id);
	}

	renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
		el.addClass("todo-icon-option");
		const glyph = el.createSpan({ cls: "todo-icon-option-glyph" });
		setIcon(glyph, match.item);
		el.createSpan({ text: iconLabel(match.item) });
	}

	onChooseItem(id: string): void {
		this.onPick(id);
	}
}
