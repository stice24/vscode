# Context Bubble — Claude Code Context File

This file provides persistent context for Claude Code sessions working on the Context Bubble feature. Read this before generating any code, making architectural assumptions, or suggesting approaches.

---

## What We're Building

A **context bubble widget** for a forked Code OSS IDE. The core concept: a developer highlights a function, hits a hotkey, and a floating bubble appears — surfacing call graph, git/PR history, and Slack mentions directly alongside the code. The bubble is draggable, resizable, and spatially persistent.

This is a **UI-first product**. The spatial, in-context bubble experience is the core differentiator. Data integrations are the means to a strong end product.

---

## Repository Context

- This is a fork of **Code OSS** (MIT-licensed upstream of VS Code)
- The fork exists to build the full vision without extension API constraints
- A VS Code extension extraction may happen later for distribution — do not design against that now
- Phase 1 (fork setup, dev loop validation) is complete
- Phase 2 (context bubble implementation) is active
- Sessions 1 and 2 are complete — scaffold, drag/resize, anchor, arrow, and core aesthetic are built

---

## Architecture — Decisions Already Made

### Process Layer
- The bubble lives entirely in the **Renderer / Workbench layer** (Chromium renderer process)
- Do not put bubble logic in the main process or a webview
- Cross-process calls (e.g. git via main process services) happen via existing IPC infrastructure — do not reinvent

### DOM Approach
- **Fully custom DOM element** — do not extend or subclass existing overlay widgets (hover widget, suggest widget, etc.)
- The bubble element is created imperatively, positioned absolutely, z-indexed above the editor surface
- Borrow specific utilities from existing infrastructure (listed below) but own the element and its lifecycle entirely

### What to Borrow from Existing Infrastructure
- **Symbol-to-screen coordinate resolution** — for initial bubble placement at trigger time
- **Z-index layering conventions** — slot the bubble above the editor but below notifications/dialogs
- **`IDisposable` pattern** — use for all event listener and DOM cleanup on dismiss
- **Existing Code OSS git services** — do not shell out to git directly; use what's already there
- **`workbench.configuration`** — for slot config persistence

### What NOT to Borrow
- Do not inherit hover widget show/hide behavior
- Do not inherit cursor-follow or auto-dismiss behavior
- The bubble's lifecycle is entirely self-managed

---

## The Interaction Model

### Trigger (Stage 1)
- Developer highlights a function → hits hotkey (Shift-CMD-J)
- A small anchor element ("+") appears near the function header, pinned to that line, as a gutter decoration that scrolls with the code
- Tagged alongside the "+", cleanly with respect to UI, is a "Context Bubble" label highlighted in a small shape — keep it clean
- **Data prefetch begins immediately at trigger** — do not wait for the bubble to open

### Open (Stage 2)
- Developer drags from the anchor → bubble expands and follows
- On drop, bubble is placed at that position and fully opens
- A bezier curve SVG arrow connects anchor to bubble, rendered in an absolutely positioned SVG layer between the editor and the bubble
- Arrow is cool blue/cyan, low opacity, thin stroke
- Arrow fades out after **5 seconds** with an 800ms ease-out opacity transition
- Arrow also disappears immediately on any interaction with the bubble

### Drag and Resize
- Position updates run directly against `element.style` on `mousemove` — no state update cycle in the hot path
- Resize handles appear on bubble border hover only — not permanently visible, subtle cyan tint when active
- Minimum bubble size enforced so slots remain readable
- **No snap-to-grid** — free floating only
- Glow intensifies slightly while dragging — no other visual change during drag
- Satisfying feel is a requirement, not a nice-to-have

### Hide vs Close
These are two distinct operations:

**Hide (`−` button in bubble chrome)**
- Collapses bubble to hidden state
- Anchor remains visible in the gutter near the symbol
- Status bar indicator appears (right side) showing a bubble exists in hidden state
- Bubble data and last dragged position are preserved in memory

**Re-expanding from hidden**
- Via anchor: click the gutter anchor → bubble re-expands at last dragged position
- Via status bar: click indicator → editor scrolls to anchor location → bubble re-expands at last dragged position
- Both paths sync: re-expanding via either clears the status bar indicator

**Close (`×` button in bubble chrome)**
- Destroys bubble entirely
- Clears all state
- Removes gutter anchor
- Clears status bar indicator
- Re-triggering hotkey opens a fresh bubble

---

## Visual Design Decisions

### Surface
- Dark background: ~#0d0f12, find the closest Code OSS dark theme token
- Subtle top-to-bottom or radial gradient — not flat
- 14px border radius
- **Feathered edges via CSS mask** — bubble edges softly fade into the editor. Do not use a hard border as the primary edge treatment. Content should feel like it emerges from the editor surface
- Layered box-shadow: one tight close-in shadow, one diffuse ambient shadow further out — both dark, not light

### Glow
- Subtle cyan/blue glow on the bubble border — low opacity, not aggressive, not neon
- Glow intensifies slightly on hover and during drag

### Slot Dividers
- Gradient separator between slots: transparent → faint cyan/blue → transparent horizontally
- Not a hard line

### Configuration Mode (Slot Rearrangement)
- Triggered by dragging **within** the bubble to rearrange slots — not by dragging the bubble itself
- A grey glowing background overlay appears inside the bubble revealing drop zones per slot position
- Drop zones glow softly when a slot is dragged over them
- Overlay fades out when drag ends
- Slots snap to grid positions within the bubble

### Typography
- **UI chrome** (slot labels, controls, timestamps): system sans-serif, small, low contrast against background — present but not loud
- **Code content** (function names, file paths, symbols): monospace, inheriting the editor font where possible
- **Slot labels**: uppercase, tracked out, very small — subtle category markers

### Controls
- Hide (`−`) and Close (`×`) in top right of bubble chrome
- Very low opacity at rest, full opacity on bubble hover
- No background on buttons — glyphs only

### What To Never Do Visually
- Do not use white backgrounds anywhere
- Do not use hard borders as the primary edge — the mask/feather is the edge
- Do not make the glow aggressive or neon
- Do not add animations beyond what is specified

---

## Slot System

### Layout
- 3 slots, vertically stacked by default
- Default assignment: call graph (top), git/PR history (middle), Slack mentions (bottom)
- Slots are user-configurable via drag-and-drop within the bubble — config persists via `workbench.configuration`
- Slot rearrangement uses the configuration mode overlay (see above)
- Each internal slot can be resized within the bounds of the bubble, shifting the others with it if moved

### Slot State Model
Each slot independently tracks:
```
loading | success | error
```
- Slots load and display independently — a slow or failed slot does not block others
- Error state is per-slot and does not collapse the bubble
- Do not design a "wait for all slots" loading pattern

### Slot Configuration
- Wired to `workbench.configuration` from the start
- No hardcoded slot assignments anywhere in the codebase

---

## Bubble Focus Mode

- Double-clicking a slot expands it to fill the entire bubble space
- A back button (`<`) returns to the standard 3-slot view
- Each slot has distinct capabilities in focus mode (see per-slot details below)

---

## Data Sources

### Call Graph (Slot 1)
- Source: **LSP** (Language Server Protocol)
- Async round trip — slot will be in loading state initially
- Query: callers and callees of the highlighted symbol
- Rendered as a directed node graph, visually clean
- **Focus mode behavior:**
  - Cmd-click on a node in the call graph collapses the current bubble entirely
  - Editor auto-scrolls to the clicked function and highlights it
  - The anchor + "Context Bubble" widget appears on the new function
  - This creates a new bubble context — see Bubble History State below

### Git / PR History (Slot 2)
- Source: **Existing Code OSS git services** — audit what's available before writing anything new
- Local disk read — should be low latency
- Query: commit history scoped to the function's line range (`git log -L` equivalent)
- Line-range history preferred over file-level for precision, despite being slower

### Slack Mentions (Slot 3)
- Source: **Slack Search API** (live, on-demand)
- Auth required — treat as a configured integration
- Query: function name as search term against relevant channels
- Known limitation: noisy for generic function names — acceptable for now
- A pre-indexed/cached layer is a future improvement, not in scope for Phase 2
- **This slot may be stubbed initially** — architecture must accommodate it cleanly

---

## Bubble History State

- When a call graph cmd-click navigates to a new function, a bubble history stack is maintained
- A back arrow appears in the new bubble's chrome (distinct from the focus mode back button) indicating a previous bubble context exists
- Clicking it restores the previous bubble state: symbol, position, slot data, scroll position
- History is linear — no branching. Each navigation pushes to the stack, back pops it
- History is session-scoped — does not persist across IDE restarts

---

## Multiple Bubbles
- **One bubble at a time** — this is a UX constraint, not an architectural one
- Build the bubble manager to support a collection internally
- The UI enforces single instance by replacing or blocking on re-trigger while one exists

---

## Hotkey
- Register a custom keybinding via the Code OSS keybinding registry
- Audit existing bindings before assigning — do not stomp on defaults
- Same hotkey re-expands a hidden bubble if one exists (does not open a fresh bubble)

---

## What Is Not Decided Yet
- Whether a future VS Code extension extraction changes any of the above

---

## What To Never Do
- Do not extend `HoverWidget`, `SuggestWidget`, or any existing overlay class for the bubble
- Do not shell out to `git` directly — use existing Code OSS git services
- Do not wait for all slots before showing the bubble
- Do not hardcode slot assignments
- Do not put bubble logic in the main process or a webview
- Do not use a state update cycle in the drag `mousemove` hot path
- Do not use white backgrounds anywhere in the bubble UI
- Do not make the glow aggressive or neon
- Do not use hard borders as the primary edge treatment