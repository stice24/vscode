# Context Bubble — Claude Code Context File

Read this before generating any code, making architectural assumptions, or suggesting approaches. This is the source of truth for decisions made. Do not override decisions documented here without flagging the conflict explicitly.

---

## What We're Building

A **context bubble widget** for a forked Code OSS IDE. The core concept: a developer highlights a function, hits a hotkey, and a floating bubble appears — surfacing call graph, git/PR history, and Slack mentions directly alongside the code. The bubble is draggable, resizable, and spatially persistent.

This is a **UI-first product**. The spatial, in-context bubble experience is the core differentiator. Data integrations are secondary and should not drive architectural decisions.

---

## Where We Are

Phase 1 (fork setup, dev loop validation) — complete
Phase 2 (context bubble implementation) — active

- Session 1 — Core scaffold: contribution registration, keybinding, `ContextBubbleWidget` class, `SlotComponent` base class, hotkey wired to symbol capture — complete
- Session 2 — Anchor, bezier arrow, core aesthetic — complete
- Session 3 — Hide/show system, status bar indicator, anchor persistence, re-expand sync — complete
- Session 4 — Slot UI components with mocked data, slot configurability architecture — complete
- Session 5 — Bubble focus mode, cmd-click call graph navigation — complete
- Session 6 — Bubble history state — complete
- Session 7 — LSP wiring for call graph slot — complete
- Session 8 — Git wiring (Code OSS git services, line-range scoped) — complete
- Session 9 — Slack wiring (Slack Search API, auth, results in slot 3) — complete

**All three slot backends are wired. Each slot has a barebones frontend reflecting live data. The current focus is fine-tuning and hardening what exists.**

---

## What Is Coming

- **Next — Slot configuration persistence**: `workbench.configuration` fully wired. Drag-to-rearrange order persists across sessions.
- **Polish pass**: drag/resize feel audit, feathered edge verification, glow tuning, slot visual refinement.
- **Hardening**: dispose/cleanup audit, memory leak check, edge cases (no symbol selected, LSP unavailable, Slack unreachable, git not initialized), hotkey behavior with hidden bubble.

---

## Repository Context

- This is a fork of **Code OSS** (MIT-licensed upstream of VS Code)
- The fork exists to validate the full concept without extension API constraints
- A VS Code extension extraction may happen later for distribution — do not design against that now

---

## Architecture — Decisions Already Made

### Process Layer
- The bubble lives entirely in the **renderer / workbench layer** (Chromium renderer process)
- Do not put bubble logic in the main process or a webview
- Cross-process calls (e.g. git via main process services) happen via existing IPC infrastructure — do not reinvent
- No backend — everything runs locally on the user's machine

### DOM Approach
- Fully custom DOM element — do not extend or subclass existing overlay widgets
- Borrowing Code OSS utilities: `IDisposable` pattern, coordinate resolution, existing services
- Single bubble instance at a time

### Data Sources
- **Call graph** — `CallHierarchyProvider` preferred (incoming + outgoing calls). `ReferenceProvider` + `DefinitionProvider` as fallback. Do not assume provider availability — audit before implementing.
- **Git history** — Code OSS existing git services, scoped to file and line range. Do not shell out directly.
- **Slack mentions** — Slack Search API called directly from the workbench renderer using a configured auth token stored in VS Code settings. No backend proxy.

---

## Visual Design — Decisions Already Made

- Surface: dark ~`#0d0f12`, subtle gradient, no white backgrounds
- Border radius: 14px, feathered edges via CSS mask (content fades at bubble edges, no hard border)
- Accent: cool blue / cyan
- Shadows: layered box-shadows for depth
- Slot dividers: subtle gradient separator
- Typography: monospace for code content and identifiers, sans-serif for UI chrome
- Slot labels: uppercase, tracked out, very small, low contrast — category marker above content
- Slot states: loading uses skeleton/pulse animation (no spinner), error is minimal inline message that does not collapse the slot

### Slot Configuration UI
- Two-stage flow: layout preset selection first, then drag-and-drop source assignment
- When dragging within the bubble to rearrange slots, a grey glowing configuration overlay appears showing drop zones. It fades in during drag and disappears on drop.
- Default slot order: call graph (top), git/PR history (middle), Slack mentions (bottom)

---

## Interaction Model

- Hotkey triggers symbol capture + prefetch + anchor render
- Bubble is draggable and resizable — satisfying feel is a core product requirement
- Arrow from anchor to bubble fades after ~5 seconds
- Hide: collapses to gutter anchor + status bar indicator
- Re-expand: from gutter anchor or status bar — scrolls to anchor, restores bubble at last dragged position
- Close: destroys bubble and anchor entirely
- Focus mode: double-click slot expands it to fill bubble; back button returns to 3-slot view
- History: call graph cmd-click navigates to new function, pushes history stack; back arrow in chrome pops to previous symbol, position, and slot data

---

## Current Focus — Fine Tuning

The barebones structure is complete end-to-end. Work from here should improve what exists rather than add new systems. When making changes:

- Prefer refining existing components over adding new ones
- Any visual change should be checked against the design decisions above
- Slot data loading should remain async and independent — no slot should block another
- Do not re-architect working systems unless there is a documented reason