# Context Bubble — Claude Code Context File

This file provides persistent context for Claude Code sessions working on the Context Bubble feature. Read this before generating any code, making architectural assumptions, or suggesting approaches.

---

## What We're Building

A **context bubble widget** for a forked Code OSS IDE. The core concept: a developer highlights a function, hits a hotkey, and a floating bubble appears — surfacing call graph, git/PR history, and Slack mentions directly alongside the code. The bubble is draggable, resizable, and spatially persistent.

This is a **UI-first product**. The spatial, in-context bubble experience is the core differentiator. Data integrations are the means to a strong end product.

---

## Repository Context

- This is a fork of **Code OSS** (MIT-licensed upstream of VS Code / Kiro IDE)
- The fork exists to build the full vision without extension API constraints
- A VS Code extension extraction may happen later for distribution — do not design against that now
- Phase 1 (fork setup, dev loop validation) is complete
- Phase 2 (context bubble implementation) is active

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
- Developer highlights a function → hits hotkey
- A small anchor element ("+") appears near the function header, pinned to that line
- Tagged along with this ("+"), cleanly with respect to UI, is ("Context Bubble"), highlighted in a little shape, just make it look clean
- **Data prefetch begins immediately at this point** — do not wait for the bubble to open
- The anchor behaves as a gutter decoration — it scrolls with the code

### Open (Stage 2)
- Developer drags from the anchor → bubble expands and follows
- On drop, bubble is placed at that position and fully opens
- A bezier curve arrow connects anchor to bubble
- Arrow fades out after **5 seconds** with an ~800ms ease-out opacity transition
- Arrow also disappears immediately on any interaction with the bubble

### Drag and Resize
- Position updates run directly against `element.style` on `mousemove` — no state update cycle in the hot path
- Resize handles appear on hover of bubble border — not permanently visible
- Minimum bubble size enforced so slots remain readable
- **No snap-to-grid** — free floating only
- Users will be able to configure the elements of the context bubble, which can be rearranged. They're masked into the space chosen by the developer
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

## Slot System

### Layout
- 3 slots, vertically stacked by default
- Default assignment: call graph (top), git/PR history (middle), Slack mentions (bottom)
- Slots are user-configurable — config persists via `workbench.configuration`
- These will be more snap to grid slots, providing translucent backgrop configuration options for users to drag and drop

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

## Data Sources

### Call Graph (Slot 1)
- Source: **LSP** (Language Server Protocol)
- Async round trip — slot will be in loading state initially
- Query: callers and callees of the highlighted symbol
- Will come out as a nicely displayed directed node graph

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
## Bubble Focus
- When the user double clicks on a certain section of the bubble (e.g. call graph), that section will fill the entire bubble space
- There will be a back button ("<") to return to the high level bubble, but this gives a focused in view, where each section has certain capabilities, as follows:

### Call Graph (Slot 1)
- If the user cmd-clicks on one of these functions, the following happens:
- The bubble and previous highlight collapses entirely
- The page auto-scrolls up to the function that was clicked, and the function is highlighted with a new context bubble option
- This also introduces statefulness to actual bubble calls:

### Bubble History State
- If something like the scenario described in the call graph history occurs, a back arrow should appear next to the smaller back arrow
- It should indicate moving back to the previous context bubble, not the previous view within the bubbble
- So, if a new function is highlighted and has the ("Context Bubble +") widget, and it's coming from clicking in the call graph, there should now be optionality to quickly snap back to the former bubble state that got us there

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
- Exact hotkey assignment (pending keybinding registry audit)
- Whether Slack slot is live or stubbed in Phase 2
- Specific visual styling / color tokens beyond dark theme compatibility
- Whether a future VS Code extension extraction changes any of the above

---

## What To Never Do
- Do not extend `HoverWidget`, `SuggestWidget`, or any existing overlay class for the bubble
- Do not shell out to `git` directly — use existing Code OSS git services
- Do not wait for all slots before showing the bubble
- Do not hardcode slot assignments
- Do not put bubble logic in the main process or a webview
- Do not use a state update cycle in the drag `mousemove` hot path