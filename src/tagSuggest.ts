// Shared @-tag suggestion dropdown, attached to any text input used to
// compose a task (add-row, inline edit, the modal's Text field) or the
// search box. One attachment per input instance — these inputs are torn
// down and recreated on every re-render, so callers attach fresh each time.

import { setIcon } from "obsidian";
import type { TagInfo } from "./store";
import { humanizeTag, tagMatchesQuery } from "./todotxt";

const MAX_SUGGESTIONS = 8;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

interface ActiveToken {
	start: number; // index of '@' in input.value
	query: string; // text typed after '@', up to the caret
}

export interface TagSuggestOptions {
	// Fired the instant a suggestion is committed (Enter/click), before the
	// synthetic "input" event is dispatched. Callers whose input gets torn
	// down and rebuilt on every keystroke (i.e. search) need this signal so
	// the freshly-mounted replacement doesn't immediately reopen the
	// dropdown on the tag it was just given.
	onCommit?: () => void;
}

export interface TagSuggestHandle {
	// Re-derive the dropdown from the input's current value/caret. Callers
	// whose input survives a full re-render mid-typing (i.e. search) must
	// call this after restoring focus, since the native "input" event that
	// would normally drive this fired on the element that just got replaced.
	sync(): void;
}

export function attachTagSuggest(
	input: HTMLInputElement,
	anchor: HTMLElement,
	getTags: () => TagInfo[],
	options: TagSuggestOptions = {}
): TagSuggestHandle {
	let dropdown: HTMLElement | null = null;
	let items: TagInfo[] = [];
	let selectedIndex = 0;
	let active: ActiveToken | null = null;
	let suppressNextInput = false;

	const close = (): void => {
		dropdown?.remove();
		dropdown = null;
		active = null;
		input.removeClass("todo-tag-suggest-active");
	};

	const findActiveToken = (): ActiveToken | null => {
		const value = input.value;
		const caret = input.selectionStart ?? value.length;
		let i = caret;
		while (i > 0 && WORD_CHAR_RE.test(value[i - 1])) i--;
		if (i === 0 || value[i - 1] !== "@") return null;
		if (i - 1 > 0 && !/\s/.test(value[i - 2])) return null;
		return { start: i - 1, query: value.slice(i, caret) };
	};

	const render = (): void => {
		if (!active) {
			close();
			return;
		}
		items = getTags()
			.filter((t) => tagMatchesQuery(t.display, active!.query))
			.slice(0, MAX_SUGGESTIONS);
		if (items.length === 0) {
			close();
			return;
		}
		selectedIndex = Math.min(selectedIndex, items.length - 1);

		if (!dropdown) {
			if (getComputedStyle(anchor).position === "static") {
				anchor.setCssStyles({ position: "relative" });
			}
			dropdown = anchor.createDiv({ cls: "todo-tag-suggest" });
			input.addClass("todo-tag-suggest-active");
		}
		dropdown.empty();
		dropdown.setCssStyles({
			top: `${input.offsetTop + input.offsetHeight}px`,
			left: `${input.offsetLeft}px`,
			minWidth: `${Math.max(input.offsetWidth, 160)}px`,
		});

		items.forEach((t, idx) => {
			const row = dropdown!.createDiv({ cls: "todo-tag-suggest-item" });
			if (idx === selectedIndex) row.addClass("is-selected");
			const ic = row.createSpan({ cls: "todo-tag-suggest-icon" });
			setIcon(ic, "at-sign");
			row.createSpan({ text: humanizeTag(t.display) });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault(); // keep focus (and selection) in the input
				selectedIndex = idx;
				commit();
			});
		});
	};

	const commit = (): void => {
		if (!active || items.length === 0) return;
		const chosen = items[selectedIndex];
		const value = input.value;
		const caret = input.selectionStart ?? value.length;
		const before = value.slice(0, active.start);
		const after = value.slice(caret);
		const inserted = "@" + chosen.display;
		input.value = before + inserted + after;
		const newCaret = before.length + inserted.length;
		input.setSelectionRange(newCaret, newCaret);
		close();
		suppressNextInput = true;
		options.onCommit?.();
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};

	const sync = (): void => {
		active = findActiveToken();
		selectedIndex = 0;
		render();
	};

	input.addEventListener("input", () => {
		if (suppressNextInput) {
			suppressNextInput = false;
			return;
		}
		sync();
	});

	input.addEventListener("keydown", (e) => {
		if (!dropdown || items.length === 0) return;
		if (e.key === "Tab") {
			e.preventDefault();
			e.stopImmediatePropagation();
			selectedIndex = e.shiftKey
				? (selectedIndex - 1 + items.length) % items.length
				: (selectedIndex + 1) % items.length;
			render();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			e.stopImmediatePropagation();
			selectedIndex = (selectedIndex + 1) % items.length;
			render();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			e.stopImmediatePropagation();
			selectedIndex = (selectedIndex - 1 + items.length) % items.length;
			render();
		} else if (e.key === "Enter") {
			e.preventDefault();
			e.stopImmediatePropagation();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopImmediatePropagation();
			close();
		}
	});

	return { sync };
}
