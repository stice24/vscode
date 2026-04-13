# Context Bubble — Claude Code Context File

This file provides persistent context for Claude Code sessions working on the Context Bubble feature. Read this before generating any code, making architectural assumptions, or suggesting approaches.

---

## What We're Building

A **context bubble widget** for a forked Code OSS IDE. The core concept: a developer highlights a function, hits a hotkey, and a floating bubble appears — surfacing call graph, git/PR history, and Slack mentions directly alongside the code. The bubble is draggable, resizable, and spatially persistent.

This is a **UI-first product**. The spatial, in-context bubble experience is the core differentiator. Data integrations are the means to a strong end product.

---

## Where We Are

- Phase 1 (fork setup, dev loop validation) — complete
- Phase 2 (context bubble implementation) — active
- Session 1 — Core scaffold: contribution registration, keybinding, `ContextBubbleWidget` class, `SlotComponent` base class, hotkey wired to symbol capture — complete
- Session 2 — Anchor, bezier arrow, core aesthetic — complete
- Session 3 — Hide/show system, status bar indicator, anchor persistence, re-expand sync — complete
- Session 4 — Slot UI components with mocked data, slot configurability architecture — complete
- Session 7 — LSP wiring (CallHierarchyProvider), cmd-click navigation, bubble history stack — complete
- Session 8 — Git wiring (real commit history from Code OSS git services)

---

## What Is Coming
- Session 9 — Slack wiring (Slack Search API, auth, results in slot 3)
- Session 10 — Slot configuration persistence (workbench.configuration fully wired)
- Session 11 — Polish and hardening

---

## Repository Context

- This is a fork of **Code OSS** (MIT-licensed upstream of VS Code / Kiro IDE)
- The fork exists to build the full vision without extension API constraints
- A VS Code extension extraction may happen later for distribution — do not design against that now

---

## Architecture — Decisions Already Made

### Process Layer
- The bubble lives entirely in the **Renderer / Workbench layer** (Chromium renderer process)
- Do not put bubble logic in the main process or a webview
- Cross-process calls (e.g. git via main process services) happen via existing IPC infrastructure — do not reinvent
- No backend is required — everything runs locally on the user's machine

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
- **`CallHierarchyProvider`, `ReferenceProvider`, `DefinitionProvider`** — for LSP wiring; audit availability before building against them

### What NOT to Borrow
- Do not inherit hover widget show/hide behavior
- Do not inherit cursor-follow or auto-dismiss behavior
- The bubble's lifecycle is entirely self-managed

---

## The Interaction Model

### Trigger (Stage 1)
- Developer highlights a function → hits hotkey
- A small anchor element ("+") appears near the function header, pinned to that line, as a gutter decoration that scrolls with the code
- The anchor should be immediately noticeable — full cyan/blue accent at full opacity, not muted
- Tagged alongside the "+", cleanly, is a "Context Bubble" label highlighted in a small shape — clearly readable, sufficient contrast against both light and dark editor themes
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
- Destroys bubble entirely, clears all state, removes gutter anchor, clears status bar indicator
- Re-triggering hotkey opens a fresh bubble

---

## Visual Design — Decisions Locked

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
- Triggered by a dedicated config icon in the bubble chrome — not by dragging a slot directly
- Opens a full-bubble overlay — current slot content dimmed behind it
- Overlay first presents named layout preset tiles:
  - 3 stacked vertically (default)
  - 1 large bottom, 2 split top
  - 1 large top, 2 split bottom
  - 3 horizontal side by side
  - 1 full bleed
- Selecting a preset transitions the overlay into drag-and-drop assignment mode
- Data source chips (callGraph, gitHistory, slackMentions) are dragged into drop zones
- Swaps are intelligent — dropping onto an occupied zone swaps the two sources
- Unassigned zones render as empty placeholder slots
- Confirm commits and writes to `workbench.configuration` immediately
- Cancel discards with no state change
- Overlay fades in and out — does not hard cut
- Drop zones: grey glowing outlined areas, cyan glow intensifies on drag-over

### Typography
- **UI chrome** (slot labels, controls, timestamps): system sans-serif, small, low contrast — present but not loud
- **Code content** (function names, file paths, symbols): monospace, inheriting the editor font where possible
- **Slot labels**: uppercase, tracked out, very small — subtle category markers

### Controls
- Hide (`−`), Close (`×`), and config icon in top right of bubble chrome
- Very low opacity at rest, full opacity on bubble hover
- No background on buttons — glyphs only

---

## Slot System

### Layout
- 3 slots, vertically stacked by default
- Default assignment: call graph (top), git/PR history (middle), Slack mentions (bottom)
- Slots are user-configurable via the configuration mode overlay

### Slot Identification
- Position keys: `slot.top`, `slot.middle`, `slot.bottom`
- Source identifiers: `contextBubble.callGraph`, `contextBubble.gitHistory`, `contextBubble.slackMentions`
- Configuration maps position keys to source identifiers
- Slot components registered in a map — adding a new source = one map entry

### Slot State Model
Each slot independently tracks:
```
loading | success | error
```
- Slots load and display independently
- Error state is per-slot and does not collapse the bubble
- Loading: subtle skeleton or pulse animation — no spinner
- Do not design a "wait for all slots" loading pattern
- State belongs to the data source instance, not the slot position

---

## Bubble Focus Mode

- Double-clicking a slot expands it to fill the entire bubble space
- A back button (`<`) returns to the standard 3-slot view
- Call graph focus mode supports cmd-click navigation (see below)

---

## Data Sources

### Call Graph (Slot 1)
- Source: **LSP** via Code OSS's existing provider layer
- Preferred: `CallHierarchyProvider` — `resolveCallHierarchyIncomingCalls` for callers, `resolveCallHierarchyOutgoingCalls` for callees
- Fallback: `ReferenceProvider.provideReferences` for callers; `documentSymbol` + `DefinitionProvider` scan for callees
- Audit provider availability before building — do not assume
- Rendered as a directed node graph: center node = triggered symbol, callers left, callees right
- Nodes: small circles, monospace labels, cyan/blue accent on center node
- Edges: thin low-opacity directional arrows
- **Cmd-click on a node:**
  - Collapses current bubble entirely
  - Editor scrolls to clicked function
  - Anchor + "Context Bubble" label appears on new function
  - Previous bubble state pushed to history stack

### Git / PR History (Slot 2)
- Source: **Existing Code OSS git services** — audit before writing anything new
- Query: commit history scoped to the function's line range
- Each entry: short monospace hash, author, relative timestamp, commit message
- PR number references rendered as distinguishable inline tags
- Subtle left border accent per entry

### Slack Mentions (Slot 3)
- Source: **Slack Search API** called directly from the workbench renderer
- Auth token stored in VS Code settings — no backend required
- Query: function name as search term against relevant channels
- Each entry: username (cyan/blue monospace), message body (sans-serif), relative timestamp
- May be stubbed initially — architecture must accommodate real wiring cleanly

---

## Bubble History State

- When cmd-click navigates to a new function, previous bubble state is pushed to a linear history stack
- A back arrow appears in the new bubble's chrome (distinct from focus mode back button)
- Clicking it restores previous state: symbol, position, slot data, scroll position
- History is linear — no branching
- Session-scoped — does not persist across IDE restarts

---

## Multiple Bubbles
- **One bubble at a time** — UX constraint, not architectural
- Bubble manager supports a collection internally
- UI enforces single instance on re-trigger

---

## Hotkey
- Registered via Code OSS keybinding registry — no conflicts with defaults
- Same hotkey re-expands a hidden bubble if one exists

---

## What Is Not Decided Yet
- Exact hotkey assignment — document chosen key here once decided
- Whether Slack slot is live or stubbed in Phase 2
- Whether a future VS Code extension extraction changes any of the above

---

## What To Never Do
- Do not extend `HoverWidget`, `SuggestWidget`, or any existing overlay class
- Do not shell out to `git` directly — use existing Code OSS git services
- Do not open a raw LSP connection — use Code OSS's existing provider layer only
- Do not wait for all slots before showing the bubble
- Do not hardcode slot assignments
- Do not put bubble logic in the main process or a webview
- Do not use a state update cycle in the drag `mousemove` hot path
- Do not use white backgrounds anywhere in the bubble UI
- Do not make the glow aggressive or neon
- Do not use hard borders as the primary edge treatment
- Do not re-fetch data when slots are rearranged
- Do not couple slot state to slot position
- Do not use spinners for loading states
