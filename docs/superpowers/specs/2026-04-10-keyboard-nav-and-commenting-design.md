# Keyboard Navigation & Commenting Design

Date: 2026-04-10

## Overview

Three features for claude-review's viewer:

1. **URL bug fix** — resolve doubled path in the review command's URL generation
2. **Keyboard-driven cursor navigation** — arrow keys move a visible cursor through rendered markdown content at word/line granularity
3. **Keyboard commenting** — `c` to comment on selected text, `]`/`[` to expand/shrink selection scope

These features turn the mouse-only review workflow into a keyboard-first experience while preserving all existing mouse-based interactions.

## Feature 1: URL Bug Fix

### Problem

`main.go:247-252` builds the viewer URL:

```go
reviewURL := fmt.Sprintf(
    "http://localhost:%s/projects%s/%s",
    port,
    escapePathComponents(*projectDir),
    escapePathComponents(*filePath),
)
```

The `--file` flag is documented as relative to the project directory, but nothing enforces this. When an absolute path is passed (common from the `/cr-review` slash command), the project directory appears twice in the URL.

### Fix

Before building the URL, normalize `filePath` to be relative to `projectDir` using `filepath.Rel`, which correctly handles `..`, `.`, trailing slashes, and symlinks:

```go
if filepath.IsAbs(*filePath) {
    rel, err := filepath.Rel(*projectDir, *filePath)
    if err == nil && !strings.HasPrefix(rel, "..") {
        *filePath = rel
    }
}
```

## Feature 2: Keyboard Cursor Navigation

### Architecture: Hybrid Block Index + Range API

Two-level navigation system. A block index handles vertical movement. The Range API handles horizontal word-level movement within blocks.

### Block Index

Built on page load by scanning `#markdown-content` for block-level elements. Each entry:

```
{
  element: HTMLElement,
  lineStart: number,         // from data-line-start
  lineEnd: number,           // from data-line-end
  rect: DOMRect,             // bounding box
  headingLevel: number|null  // 1-6 for headings, null otherwise
}
```

**Block elements:** `p`, `h1`-`h6`, `li`, `pre`, `td`, `blockquote`. Tables are navigated cell-by-cell (`td`), not row-by-row.

**Rebuilding:** Full rebuild on page load (which also covers `file_updated` SSE events, since those trigger a full page reload via `window.location.reload()`). `ResizeObserver` refreshes `rect` values on window resize without full rebuild.

### Word-Level Cursor

The cursor tracks `{textNode, wordStart, wordEnd}` within the current block.

**Left/Right arrows:** Move word by word. Word boundaries are whitespace and punctuation (preserving contractions like `don't`). At block edges, wraps to the adjacent block.

**Up/Down arrows:** Move to the adjacent block via the block index. The cursor lands on the word whose horizontal center is closest to the previous cursor's X position. The target X persists across consecutive up/down presses (reset on left/right), matching standard text editor behavior.

### Visual Cursor

- Absolutely-positioned overlay `<div id="word-cursor">` with a soft highlight (e.g., `rgba(100, 149, 237, 0.25)`)
- Positioned via `getBoundingClientRect()` on the current word's Range
- Current block gets a subtle left-border or background tint
- Visible only during keyboard navigation — disappears on mouse click or text input focus

### Activation

- Any arrow key activates keyboard nav if not active
- Mouse click deactivates it
- `Escape` from a comment popup returns to keyboard nav at the previous position (note: existing `hideCommentPopup` has no `Escape` handler — one must be added as part of this work)

## Feature 3: Selection Expansion & Commenting

### Expansion Levels

Starting from the cursor word, `]` expands and `[` shrinks:

| Level | Scope | Detection method |
|-------|-------|-----------------|
| 0 | Word | Current cursor position |
| 1 | Clause | Expand to nearest `, ; : — - ( )` delimiter |
| 2 | Sentence | Expand to `. ? !` + whitespace/end-of-block (see sentence boundary heuristic below) |
| 3 | Paragraph | Entire current block element |
| 4 | Section | Nearest preceding heading through all blocks until next heading of same or higher level (if cursor is before any heading, expands from document start to the first heading) |

**Sentence boundary heuristic:** A period, question mark, or exclamation mark is a sentence boundary when followed by whitespace + a capital letter, or end of block. Single-letter capitals after periods are not boundaries (handles "U.S.", "Dr. Smith"). This is a simple heuristic — not a full NLP sentence tokenizer. Good enough for review documents.

**Behavior:**
- `]` at level 4 does nothing. `[` at level 0 does nothing.
- Arrow keys reset to level 0 at the new cursor position.
- Selection highlight uses a distinct style from both the cursor highlight and comment highlights.
- Selected range maps to `lineStart`/`lineEnd` values from the block index for the comment API.

### The `c` Key

Context-sensitive bridge between navigation and comment modes:

**With active selection (level 1-4):**
- Opens comment popup near the selection
- Focus moves to textarea — keyboard nav deactivates
- `Enter` submits, `Escape` cancels — both return to keyboard nav

**On existing comment text (level 0, cursor on a `.comment-highlight` span):**
- Scrolls comment panel to the relevant thread
- If root comment has no replies: opens for editing
- If root comment has replies: opens a reply textarea (consistent with existing click behavior that prevents editing root comments with replies)
- Focus moves to textarea
- `Escape`/submit returns to keyboard nav

**On uncommented text with no selection (level 0):**
- Does nothing (or flashes cursor to indicate "expand first")

### Comment Panel Scroll Sync

As the cursor navigates onto text with an existing comment, the comment panel auto-scrolls to show that thread with a brief highlight pulse. This is passive (read-only) — `c` is still required to open for editing.

### Input Mode Transitions

| From | Trigger | To |
|------|---------|----|
| Keyboard nav | `c` pressed | Textarea focused (nav off) |
| Textarea focused | `Escape` or submit | Keyboard nav at previous position |
| Keyboard nav | Mouse click | Nav deactivated (mouse mode) |
| Mouse mode | Arrow key | Keyboard nav reactivated |

## File Organization

Split the current monolithic `viewer.js` into focused modules:

| File | Responsibility | Approx lines |
|------|---------------|-------------|
| `viewer.js` | Init, SSE, comment panel, mouse-based comment flow | ~600 |
| `keyboard-nav.js` | Block index, cursor state, arrow key movement, word boundaries | ~300 |
| `selection.js` | Expansion/shrinking, clause/sentence/paragraph/section detection | ~200 |
| `keyboard-comments.js` | `c` handler, context detection, panel scroll sync | ~150 |

**Module communication:** Separate `<script>` tags (no build step). Shared state via `window.crNav`:

```
window.crNav = {
  // Block index (written by keyboard-nav, read by all)
  blocks: [{element, lineStart, lineEnd, rect, headingLevel}],
  currentBlockIndex: number,

  // Cursor (written by keyboard-nav, read by selection + keyboard-comments)
  cursor: {textNode, wordStart, wordEnd} | null,
  targetX: number | null,        // persisted X for up/down movement
  active: boolean,                // whether keyboard nav mode is on

  // Selection (written by selection, read by keyboard-comments)
  selection: {
    level: 0-4,
    range: Range | null,         // browser Range for the current selection
    lineStart: number,
    lineEnd: number,
    text: string
  }
}
```

**Script load order in viewer.html:** `viewer.js` (initializes DOM, comments, SSE) → `keyboard-nav.js` → `selection.js` → `keyboard-comments.js`. All use `defer`.

**No ES modules:** The project has no build tooling. Separate scripts + shared window state keeps it that way.

## Decisions Made

- **No inline editing:** The value of claude-review is the review conversation, not markdown editing. Users edit in their editor.
- **Hybrid architecture over DOM word map:** Word-wrapping spans would conflict with existing comment highlight spans and bloat the DOM.
- **Hybrid over pure Range API:** Block index makes up/down navigation predictable and leverages existing `data-line-*` attributes.
- **`]`/`[` for expand/shrink:** Bracket metaphor, no conflict with common shortcuts.
- **Section = heading + immediate content (stops at sub-headings):** Keeps sections focused.
- **`c` is context-sensitive:** New comment on selection, edit existing comment on highlighted text — no separate mode toggle needed.
