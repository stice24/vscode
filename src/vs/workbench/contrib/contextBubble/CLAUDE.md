Read CLAUDE.md in src/vs/workbench/contrib/contextBubble/ before doing anything else. Do not write a single line of code until you have read it fully.

Session 4: Slot UI components with mocked data.

We are building the three concrete slot components. The bubble should look and feel real after this session. Use mocked/stubbed data throughout — no real LSP, git, or Slack calls yet. Architecture must accommodate real data being swapped in later without structural changes.

---

## Slot 1 — Call Graph

Render a directed node graph visualizing callers and callees of the highlighted symbol. Requirements:
- The highlighted symbol is the center node
- Callers connect into it from the left, callees branch out to the right
- Nodes are small, clean circles with function name labels
- Edges are thin, low-opacity lines with directional arrows
- Use cyan/blue accent for the center node, muted tones for surrounding nodes
- The graph should be navigable — nodes should be hoverable with a subtle highlight state
- Cmd-click on a node is wired up as a handler stub (actual navigation comes in session 5 — just make sure the hook is there)
- Mock data: at least 2 callers, 2 callees, center node is the symbol name captured at trigger time

## Slot 2 — Git / PR History

Render a clean commit list. Requirements:
- Each entry shows: commit hash (short, monospace), author, relative timestamp, and commit message
- Subtle left border accent in cyan/blue per entry
- Most recent commit at top
- If a commit message references a PR number, render it as a distinguishable tag
- Hover state per entry — subtle background shift
- Mock data: at least 4 commits with varied authors, timestamps, and one PR reference

## Slot 3 — Slack Mentions

Render a message thread list. Requirements:
- Each entry shows: username (cyan/blue accent), message content, relative timestamp
- Messages should feel like a real Slack thread — compact, readable
- Username in monospace, message body in sans-serif
- Hover state per entry
- Mock data: at least 3 messages from different users referencing the symbol name naturally

---

## All Slots — Shared Requirements

- Each slot must independently render all three states: loading, success, error
- Loading: a subtle skeleton or pulse animation — no spinner, keep it refined
- Error: a minimal inline message, does not collapse the slot or the bubble
- Success: the rendered content above
- Slot labels: uppercase, tracked out, very small, low contrast — sits above the content as a category marker
- All content respects the visual design decisions in CLAUDE.md — dark surface, mono for code content, sans for chrome, no white backgrounds

## Core Updates — Slot Configurability

### What configurability means
- Each of the 3 slots is a named, swappable position — not a hardcoded component
- The slot position (top, middle, bottom) is decoupled from the data source assigned to it
- A user can drag a slot component into a different position within the bubble
- The assignment of data source to position persists via `workbench.configuration`

### How slots are identified
- Each slot position has a stable key: `slot.top`, `slot.middle`, `slot.bottom`
- Each data source has a stable identifier: `contextBubble.callGraph`, `contextBubble.gitHistory`, `contextBubble.slackMentions`
- Configuration maps position keys to data source identifiers
- Default mapping: top → callGraph, middle → gitHistory, bottom → slackMentions

### Rendering model
- The bubble reads the current configuration on mount and renders slot components accordingly
- If configuration is absent or malformed, fall back to defaults silently
- Slot components are registered in a map — adding a new data source in the future means adding one entry to the map, nothing else

### Configuration mode (rearrangement UX)

Configuration is triggered by a dedicated button in the bubble chrome — not by dragging a slot directly.

**Triggering configuration mode**
- A settings/config icon sits in the bubble chrome alongside the hide and close controls
- Clicking it opens a full-bubble overlay — the current slot content is dimmed behind it
- The overlay presents a set of named layout presets as selectable tiles, for example:
  - 3 stacked vertically (default)
  - 1 large on bottom, 2 split horizontally on top
  - 1 large on top, 2 split horizontally on bottom
  - 3 horizontal side by side
  - 1 full bleed (single slot fills entire bubble)
- The user selects a preset first, which defines the available drop zones
- Once a preset is selected the overlay transitions into drag-and-drop assignment mode

**Drag and drop assignment**
- Each drop zone is labelled and glows softly
- The user drags data source chips (callGraph, gitHistory, slackMentions) into the zones
- Swaps are intelligent — dropping source A onto a zone already occupied by source B swaps them rather than stacking or losing one
- Unassigned zones are allowed — they render as empty placeholder slots
- A confirm button commits the configuration and closes the overlay
- A cancel button discards changes and closes the overlay with no state change

**Persisting configuration**
- On confirm, both the layout preset and the position-to-source mapping are written to `workbench.configuration`
- The bubble re-renders immediately with the new layout
- Data is not re-fetched on rearrangement — sources retain their loaded state

**Overlay appearance**
- Dark surface consistent with the bubble aesthetic
- Preset tiles: rounded, subtle border, glow on hover, filled accent on selected
- Drop zones: grey glowing outlined areas, cyan glow intensifies on drag-over
- Overlay fades in and out — does not hard cut

### What not to do
- Do not hardcode which component renders in which position anywhere
- Do not couple the slot state model (loading / success / error) to the slot position — state belongs to the data source instance, not the position
- Do not re-fetch data when slots are rearranged — data is owned by the source, position is just presentation

---

## What NOT to do
- Do not make real LSP, git, or Slack calls — mocked data only
- Do not block slot render on other slots loading
- Do not use spinners for loading state
- Do not introduce any new architectural patterns not already established in the codebase

At the end, tell me every file created or modified and why, and flag any judgment calls made so I can review them.
