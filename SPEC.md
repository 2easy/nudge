# Nudge — Spec

Nudge is a task manager built as an Obsidian plugin, backed by a single `todo.txt`-formatted
file. Built because installing third-party apps isn't allowed, but Obsidian (with community
plugins enabled) already is.

## Platform & Packaging

- Obsidian community plugin, **not** a standalone binary.
- **TypeScript + esbuild**, based on the official Obsidian sample plugin template.
- **Desktop-only, macOS-only.** No mobile support.
- Loaded locally as an unpacked dev plugin (`VaultFolder/.obsidian/plugins/nudge/`) —
  no store listing, no signing/notarization needed.
- Runs inside Obsidian's own window/process, so Cmd+Tab, Dock icon, and window sizing are
  inherited for free from Obsidian itself — nothing custom needed there.

## Storage

- Single file: `todo.txt`, stored inside the vault at a configurable path (default: vault root).
- Format: [todo.txt spec](http://todotxt.org/) with custom key:value extensions.
- **Lists** = `+ProjectName` tags on each line. Lists are **dynamically derived** by scanning
  all `+project` tags present in the file — no separate config of "which lists exist."
- A list remains visible in the sidebar as long as it has **at least one item**, completed
  or not.
- **Physical line order in the file is the display order, everywhere** — including the Today
  view. There is no separate `order:` field; position in the file *is* the order.
- **No long-lived in-memory cache.** Every render reads the file fresh from disk. Every
  mutation (checkbox toggle, drag, edit, delete) is: read current file → apply the one change
  → write back. This keeps the race window for external edits (e.g. an agent rewriting the
  file) to milliseconds.
- Plugin subscribes to the vault's `modify` event for this file and re-renders automatically
  when the file changes externally.

### Line format

```
(A) Buy milk +Groceries due:2026-07-12 link:https://example.com rec:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
x 2026-07-11 Buy milk +Groceries due:2026-07-11
```

- Priority: standard todo.txt `(A)`/`(B)`/`(C)` prefix, or omitted for "None".
  - Mapping: None / Low=(C) / Med=(B) / High=(A).
- `+ProjectName`: list membership (todo.txt spec).
- `due:YYYY-MM-DD`: due date (de facto todo.txt extension).
- `link:<url>`: custom extension for an associated link.
- `rec:<RRULE>`: custom extension. Value is a full [iCalendar RRULE](https://icalendar.org/rrule-tool.html)
  string (via the `rrule` npm library), e.g. `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` for "every
  workday", `FREQ=MONTHLY;BYDAY=1SU` for "first Sunday of the month".
- Completed items: prefixed `x <completion-date>` per spec, kept in the file (never deleted
  by completion — only explicit Delete removes a line).

## Tags (`@context`)

Any task can reference a person or context with inline `@tags` — `@matyas`, `@piotrOlchawa`,
`@email`. Tags are the todo.txt-native `@context` convention and, like lists, are
**dynamically derived** by scanning the file; there is no registry.

- A tag is a word starting with `@`, kept **in place inside the task text** — `talk to
  @matyas, then send documents` is stored exactly as typed. Sentence position is preserved;
  nothing is extracted to the end of the line the way `+project`/`due:` are.
- Tag characters: unicode letters and digits only. Anything else — comma, period, apostrophe,
  hyphen, underscore, whitespace — terminates the tag (`@matyas,` → tag `matyas`). `@` starts
  a tag only at the beginning of the text or after whitespace, so `piotrek@gmail.com` is never
  a tag.
- **ASCII folding, in-file**: non-ASCII letters in a tag token are folded to ASCII when a task
  is committed (`omów @michał's plan` → stored as `omów @michal's plan`). Only the tag token
  is folded; the rest of the text keeps its diacritics. The same folding also applies when
  reading tags for identity/counting, so a line written externally with a non-ASCII tag still
  counts correctly before the next save rewrites it.
- **Identity** is case- and diacritic-insensitive: `@Matyas`, `@matyas`, `@matyás` are one tag.
  The **canonical casing** (shown in the rail/suggestions, inserted by autocomplete) is the
  most frequent variant in the file, ties broken by first occurrence; existing lines are never
  rewritten for case. Multi-word tags are camelCase (`@piotrOlchawa`).
- **Display**: a tag renders as an accent-colored token with camelCase split into
  title-cased, spaced words — `@piotrOlchawa` → **@Piotr Olchawa**. Inline editing shows the
  raw stored form. Clicking an inline tag opens its search view (below).

### Tags in the rail

- Tags appear below the "New list" tile, after a thin separator — at-sign icon, humanized
  label, and a badge counting **incomplete** items carrying the tag.
- Sort: incomplete count desc, then completed count desc, then alphabetical.
- A tag with **zero incomplete items is hidden from the rail**, but stays findable in search
  and in the suggestion dropdown. A tag whose lines are all deleted disappears entirely.
- Tag rows are drop targets: dropping a task appends ` @tag` to its text if not already tagged.

### Tags in search

- A query starting with `@` switches search from fuzzy text matching to **tag membership**
  (word-prefix match, case/diacritic-insensitive) instead of the usual fuzzy scoring — so
  `@olch` finds tasks tagged `piotrOlchawa` via its second word. Results: incomplete on top in
  file order, completed below newest-first, in the normal Results UI.
- Clicking a tag (rail row or inline token) opens search pre-filled with `@tagname`. The
  existing 2-character minimum applies, so a bare `@` keeps showing the previous view.

### Tag suggestions

Typing `@` in the add-row, inline edit, the modal's Text field, or the search box opens a
dropdown of existing tags (word-prefix filtered as you type, e.g. `@olch` still finds
`piotrOlchawa`). **Tab**/**Shift+Tab** and **↓**/**↑** move the selection; **Enter** or a click
inserts the canonical tag with the caret placed immediately after it — no trailing space, so
`@matyas,` flows naturally. Esc closes the dropdown first; a second Esc falls through to the
input's normal Esc behavior. No match on commit simply becomes a new tag — that's the only way
tags are created.

## Views

- Custom Obsidian `ItemView` — its own pane/tab, entirely custom HTML/CSS. **Not**
  markdown-block-rendered; `todo.txt` is storage only, never viewed as a rendered note.
- Layout: sidebar-within-the-pane. Left rail = list of lists. Right = items in the
  selected list.
- Sidebar order: **"Today" pinned first**, then all other lists **alphabetically**.
- **Today view**: automatically populated filter, `due: <= today AND not done`. No manual
  add. Items whose due date is in the past render with the date **highlighted in red**
  (still shown, not hidden). An item in Today is still physically a member of its original
  `+project` list — Today is a filter, not a separate storage location.
- **Completed items**: hidden from view on the day *after* they were completed. On the day
  they're completed, they remain visible in their list (and Today, if applicable),
  struck-through — gives a sense of daily progress before disappearing.
- Items default to **read-only** display. Hovering an item reveals **Edit** and **Delete**
  icon buttons.

## Search

- Entry: a circled magnifying-glass button in the panel header, left of the **+** button,
  or a configurable hotkey (plugin settings, unset by default — e.g. Cmd+F) honored while
  the Nudge view is the active pane. Either expands the circle into an inline query input
  (animated widening).
- **Fuzzy matching** via Obsidian's built-in `prepareFuzzySearch`, over `text + cleaned link`
  per item. The link is cleaned before matching: protocol/`www.` stripped, query string and
  fragment dropped, percent-decoded, split on `/ - _ .` — so "blood angels" matches a
  `/how-to-paint-blood-angels` slug. List names are **not** searched.
- Live: results recompute on every keystroke once the query has **≥ 2 characters** (a 1-char
  fuzzy query matches nearly everything). Below 2 characters the panel keeps showing the
  previously selected view.
- **Results view**: header reads "Results". All items in the file are candidates, regardless
  of list, due date, or completion age. Incomplete matches on top sorted by score, then all
  completed matches (including completed-today) in the dimmed bottom section, also by score.
  The eye toggle starts **on** (completed shown) and is independent of the browsing views'
  eye state. Matched characters are highlighted in the item text; when the match landed in
  the link, the link button gets the same highlight.
- Result rows behave like list rows (toggle, inline edit, copy, delete, due picker). Each
  shows its list tag(s); clicking a tag exits search and navigates to that list. Dragging a
  result onto a rail target works; reordering within Results is disabled. Priority pills are
  inert. Copy-list offers the usual three formats over the visible results. No add-row —
  the **+** button exits search back to the previous view and starts an inline add there.
- Exit: **Esc** or the **✕** inside the input clears the query and returns to the previously
  selected view (selection and Today filters untouched). Clicking a rail item closes search
  and navigates. An empty input collapses back to the icon on blur.

## Dock badge (macOS)

- Optional, **off by default**: the native red Dock badge on Obsidian's icon, counting
  uncompleted overdue tasks — or overdue + due-today with "include tasks due today"
  (**on by default**), which makes the badge match the Today view count, following the
  Reminders/Things/Todoist convention.
- Zero hides the badge; completed tasks never count; list membership is irrelevant.
- Recomputed on plugin load (layout-ready), on every `todo.txt` change, on settings/path
  changes, and when the date flips: a minute tick watches for the day rollover and then
  also re-renders open views, so the Today view rolls over at midnight too.
- Implemented at the plugin level via Electron's `app.dock` (through Obsidian's exposed
  remote module), so it works with no Nudge pane open. Plugin unload, a read error, or
  disabling the toggle clears the badge.

## Item Model (Create/Edit Modal)

All fields are entered through a structured modal — no hand-typed todo.txt syntax.

| Field | Control | Encoding |
|---|---|---|
| Text | free text input | line description |
| List | dropdown of existing lists + "add new" | `+ProjectName` |
| Due date | date picker | `due:YYYY-MM-DD` |
| Priority | select: None / Low / Med / High | `(C)` / `(B)` / `(A)` / none |
| Link | URL input | `link:<url>`, rendered as a clickable 🔗 button in the list (quick one-click access to the associated link) |
| Recurrence | structured picker (see below) | `rec:<RRULE>` |

- **Edit** opens the same modal, pre-filled with the item's current values.
- **Delete** is immediate — no confirmation dialog. Relies on Obsidian's file history /
  version control for recovery, since deletion is just a line removal in a plain text file.

### Recurrence picker

- UI: dropdown for pattern type (Daily / Weekly / Monthly / Custom workdays / Nth-weekday-
  of-month), plus interval number and weekday checkboxes as needed by the chosen type.
  Builds an RRULE string internally — user never sees or types RRULE syntax.
- Storage: `rec:<RRULE>` token, computed/consumed via the `rrule` npm package.
- Mechanic: **passive only, no OS notifications.** An item just appears in Today once its
  `due:` date arrives (per the Today filter above).
- **Completion behavior:** completing a recurring item does not just mark it `x` — it also
  spawns the **next occurrence** as a new line, with a new `due:` date computed by `rrule`
  from the pattern.
- **Anchor:** the next occurrence's date is computed from the item's **original due date**,
  not the completion timestamp — so completing something late doesn't drift the recurring
  schedule forward.

## Drag and Drop

Since file line order = display order everywhere, all drags are implemented as direct
line-position/content edits in `todo.txt`:

- **Drag between lists**: rewrites the item's `+project` tag to the destination list.
- **Drag into Today**: overwrites `due:` to today's date. Destructive — original due date
  is not preserved separately.
- **Drag to reorder within a list, or within Today**: physically repositions the line in
  the file to sit at the new position. Dragging within Today can reposition a line relative
  to items that live in *different* `+project` lists elsewhere in the file — position is
  global to the file, not scoped to project tags.

## Sorting

There is no automatic sort by priority/due-date. Order is always manual, driven entirely by
physical line position in the file.

## Concurrency / External Edits

Because the file is meant to be handed to an external agent for Q&A, the plugin is
defensive about external writes:

- No in-memory state persists across renders; every operation reads the current file state
  immediately before acting.
- File-watch (`modify` event) triggers automatic re-render, so external edits (e.g. an
  agent modifying `todo.txt` directly) show up without reopening the pane.
- No file locking or conflict warnings — the collision window is considered small enough
  (milliseconds, only during truly simultaneous edits) not to warrant extra complexity.

## Explicit Non-Goals (for this version)

- OS-level notifications/popups.
- Obsidian mobile support.
- Manual sidebar reordering of lists (fixed: Today first, then alphabetical).
- Preserving an item's original due date when dragged into Today.
- Delete confirmation dialogs.
- Any standalone macOS binary / app bundle — superseded entirely by the Obsidian plugin
  approach.
