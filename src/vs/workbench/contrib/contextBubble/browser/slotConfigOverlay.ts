/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Disposable,
	DisposableStore,
} from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import * as nls from '../../../../nls.js';
import {
	ISlotConfig,
	LayoutPresetId,
	SlotPositionKey,
	SlotSourceId,
	SLOT_POSITION_KEYS,
	ALL_SOURCE_IDS,
	SOURCE_LABELS,
} from './slotComponent.js';

// ---------------------------------------------------------------------------
// Styles — injected once
// ---------------------------------------------------------------------------

let _overlayStylesInjected = false;

function ensureOverlayStyles(): void {
	if (_overlayStylesInjected) {
		return;
	}
	_overlayStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `

/* ---- Root overlay ---- */
.cbo-overlay {
	position: absolute;
	inset: 0;
	z-index: 20;
	background: rgb(12, 15, 20);
	border-radius: 13px;
	display: flex;
	flex-direction: column;
	opacity: 0;
	transition: opacity 0.18s ease;
	overflow: hidden;
}
.cbo-overlay.is-visible {
	opacity: 1;
}

/* ---- Shared phase container ---- */
.cbo-phase {
	display: none;
	flex-direction: column;
	flex: 1;
	overflow: hidden;
}
.cbo-phase.is-active {
	display: flex;
}

/* ---- Phase heading ---- */
.cbo-phase-title {
	font-size: 9px;
	text-transform: uppercase;
	letter-spacing: 0.12em;
	color: rgba(180, 190, 200, 0.38);
	padding: 14px 16px 10px;
	font-family: system-ui, -apple-system, sans-serif;
	flex-shrink: 0;
}

/* ---- Action bar (bottom of each phase) ---- */
.cbo-actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 6px;
	padding: 10px 14px 12px;
	flex-shrink: 0;
}

.cbo-btn {
	background: none;
	border: 1px solid rgba(80, 200, 220, 0.2);
	cursor: pointer;
	color: rgba(180, 190, 200, 0.72);
	font-size: 10px;
	font-family: system-ui, -apple-system, sans-serif;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	padding: 4px 12px;
	border-radius: 4px;
	transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.cbo-btn:hover {
	border-color: rgba(80, 200, 220, 0.45);
	color: rgba(210, 220, 230, 0.9);
	background: rgba(80, 200, 220, 0.06);
}
.cbo-btn-primary {
	border-color: rgba(78, 201, 176, 0.5);
	color: rgba(78, 201, 176, 0.9);
}
.cbo-btn-primary:hover {
	border-color: rgba(78, 201, 176, 0.8);
	color: rgba(78, 201, 176, 1);
	background: rgba(78, 201, 176, 0.08);
}
.cbo-btn-back {
	margin-right: auto;
	border-color: transparent;
	color: rgba(180, 190, 200, 0.45);
	padding-left: 0;
}
.cbo-btn-back:hover {
	border-color: transparent;
	background: none;
	color: rgba(180, 190, 200, 0.85);
}

/* ---- Phase 1: Preset tiles ---- */
.cbo-preset-grid {
	display: grid;
	grid-template-columns: 1fr 1fr 1fr;
	gap: 8px;
	padding: 4px 14px 8px;
	flex: 1;
	align-content: start;
}

.cbo-preset-tile {
	border: 1px solid rgba(80, 200, 220, 0.18);
	border-radius: 7px;
	padding: 10px 8px 7px;
	cursor: pointer;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 6px;
	transition: border-color 0.14s, box-shadow 0.14s, background 0.14s;
}
.cbo-preset-tile:hover {
	border-color: rgba(80, 200, 220, 0.42);
	box-shadow: 0 0 10px rgba(80, 200, 220, 0.08);
	background: rgba(80, 200, 220, 0.03);
}
.cbo-preset-tile.is-selected {
	border-color: rgba(78, 201, 176, 0.65);
	box-shadow: 0 0 14px rgba(78, 201, 176, 0.12);
	background: rgba(78, 201, 176, 0.07);
}

.cbo-preset-preview {
	width: 40px;
	height: 30px;
	flex-shrink: 0;
}

.cbo-preset-label {
	font-size: 8px;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: rgba(160, 175, 188, 0.6);
	font-family: system-ui, -apple-system, sans-serif;
	text-align: center;
	line-height: 1.3;
}
.cbo-preset-tile.is-selected .cbo-preset-label {
	color: rgba(78, 201, 176, 0.82);
}

/* ---- Phase 2: Assignment ---- */
.cbo-zone-grid {
	flex: 1;
	padding: 4px 14px 8px;
	display: grid;
	gap: 6px;
	min-height: 0;
	overflow: hidden;
}

/* Preset-specific zone grid layouts */
.cbo-zone-grid[data-preset="vertical3"] {
	grid-template-rows: 1fr 1fr 1fr;
	grid-template-columns: 1fr;
}
.cbo-zone-grid[data-preset="horizontal3"] {
	grid-template-rows: 1fr;
	grid-template-columns: 1fr 1fr 1fr;
}
.cbo-zone-grid[data-preset="largeBottom"] {
	grid-template-rows: 1fr 2fr;
	grid-template-columns: 1fr 1fr;
}
.cbo-zone-grid[data-preset="largeBottom"] .cbo-drop-zone:nth-child(3) {
	grid-column: 1 / 3;
}
.cbo-zone-grid[data-preset="largeTop"] {
	grid-template-rows: 2fr 1fr;
	grid-template-columns: 1fr 1fr;
}
.cbo-zone-grid[data-preset="largeTop"] .cbo-drop-zone:first-child {
	grid-column: 1 / 3;
}
.cbo-zone-grid[data-preset="fullBleed"] {
	grid-template-rows: 1fr;
	grid-template-columns: 1fr;
}

.cbo-drop-zone {
	border: 1px dashed rgba(80, 200, 220, 0.22);
	border-radius: 6px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 5px;
	min-height: 0;
	transition: border-color 0.14s, box-shadow 0.14s, background 0.14s;
	cursor: default;
	overflow: hidden;
}
.cbo-drop-zone.drag-over {
	border-color: rgba(78, 201, 176, 0.7);
	box-shadow: inset 0 0 16px rgba(78, 201, 176, 0.08), 0 0 12px rgba(78, 201, 176, 0.1);
	background: rgba(78, 201, 176, 0.04);
}

.cbo-zone-position-label {
	font-size: 7.5px;
	text-transform: uppercase;
	letter-spacing: 0.12em;
	color: rgba(150, 165, 178, 0.35);
	font-family: system-ui, -apple-system, sans-serif;
}

.cbo-zone-chip {
	font-size: 9.5px;
	font-family: monospace, "Courier New";
	color: rgba(78, 201, 176, 0.85);
	background: rgba(78, 201, 176, 0.1);
	border: 1px solid rgba(78, 201, 176, 0.3);
	border-radius: 4px;
	padding: 3px 9px;
	cursor: grab;
	user-select: none;
	transition: background 0.1s, border-color 0.1s;
	max-width: 90%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cbo-zone-chip:hover {
	background: rgba(78, 201, 176, 0.16);
	border-color: rgba(78, 201, 176, 0.5);
}

.cbo-empty-hint {
	font-size: 8px;
	color: rgba(130, 148, 160, 0.3);
	font-family: system-ui, -apple-system, sans-serif;
	text-transform: uppercase;
	letter-spacing: 0.08em;
}

/* ---- Source tray ---- */
.cbo-tray {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	padding: 8px 14px 0;
	flex-shrink: 0;
	min-height: 26px;
	align-items: center;
}

.cbo-tray-label {
	font-size: 8px;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: rgba(150, 165, 178, 0.3);
	font-family: system-ui, -apple-system, sans-serif;
	margin-right: 4px;
}

.cbo-tray-chip {
	font-size: 9.5px;
	font-family: monospace, "Courier New";
	color: rgba(155, 172, 188, 0.72);
	background: rgba(80, 100, 120, 0.12);
	border: 1px solid rgba(80, 100, 120, 0.28);
	border-radius: 4px;
	padding: 3px 9px;
	cursor: grab;
	user-select: none;
	transition: background 0.1s, border-color 0.1s;
	white-space: nowrap;
}
.cbo-tray-chip:hover {
	background: rgba(80, 100, 120, 0.22);
	border-color: rgba(80, 100, 120, 0.45);
}

/* ---- Drag ghost ---- */
.cbo-drag-ghost {
	position: fixed;
	pointer-events: none;
	z-index: 99999;
	font-size: 9.5px;
	font-family: monospace, "Courier New";
	color: rgba(78, 201, 176, 0.95);
	background: rgba(12, 16, 22, 0.92);
	border: 1px solid rgba(78, 201, 176, 0.5);
	border-radius: 4px;
	padding: 3px 10px;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.55), 0 0 10px rgba(78, 201, 176, 0.12);
	white-space: nowrap;
	transform: translate(-50%, -50%);
}

`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Preset visual SVG thumbnails — built with createElementNS (no innerHTML)
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** [x, y, width, height] tuples describing the preview rectangles for each preset. */
type RectSpec = [number, number, number, number];

const PRESET_RECT_SPECS: Record<LayoutPresetId, RectSpec[]> = {
	vertical3: [
		[2, 2, 36, 7],
		[2, 11, 36, 7],
		[2, 20, 36, 7],
	],
	largeBottom: [
		[2, 2, 17, 8],
		[21, 2, 17, 8],
		[2, 12, 36, 16],
	],
	largeTop: [
		[2, 2, 36, 16],
		[2, 20, 17, 8],
		[21, 20, 17, 8],
	],
	horizontal3: [
		[2, 2, 10, 26],
		[15, 2, 10, 26],
		[28, 2, 10, 26],
	],
	fullBleed: [[2, 2, 36, 26]],
};

function buildPresetSvg(presetId: LayoutPresetId): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
	svg.setAttribute('viewBox', '0 0 40 30');
	svg.style.cssText = 'width: 40px; height: 30px; display: block;';
	for (const [x, y, w, h] of PRESET_RECT_SPECS[presetId]) {
		const rect = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
		rect.setAttribute('x', String(x));
		rect.setAttribute('y', String(y));
		rect.setAttribute('width', String(w));
		rect.setAttribute('height', String(h));
		rect.setAttribute('rx', '1.5');
		rect.setAttribute('fill', 'currentColor');
		rect.setAttribute('opacity', '0.55');
		svg.appendChild(rect);
	}
	return svg;
}

const PRESET_LABELS: Record<LayoutPresetId, string> = {
	vertical3: nls.localize('slotConfig.presetStacked', "Stacked"),
	largeBottom: nls.localize('slotConfig.presetLargeBottom', "Large\nBottom"),
	largeTop: nls.localize('slotConfig.presetLargeTop', "Large\nTop"),
	horizontal3: nls.localize('slotConfig.presetHorizontal', "Side\nby Side"),
	fullBleed: nls.localize('slotConfig.presetSingle', "Single"),
};

const ALL_PRESETS: LayoutPresetId[] = [
	'vertical3',
	'largeBottom',
	'largeTop',
	'horizontal3',
	'fullBleed',
];

// How many drop zones each preset exposes
const PRESET_POSITIONS: Record<LayoutPresetId, SlotPositionKey[]> = {
	vertical3: ['slot.top', 'slot.middle', 'slot.bottom'],
	largeBottom: ['slot.top', 'slot.middle', 'slot.bottom'],
	largeTop: ['slot.top', 'slot.middle', 'slot.bottom'],
	horizontal3: ['slot.top', 'slot.middle', 'slot.bottom'],
	fullBleed: ['slot.top'],
};

const POSITION_LABELS: Record<SlotPositionKey, string> = {
	'slot.top': nls.localize('slotConfig.posTop', "Top"),
	'slot.middle': nls.localize('slotConfig.posMid', "Mid"),
	'slot.bottom': nls.localize('slotConfig.posBot', "Bot"),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result emitted when the user confirms a configuration change. */
export interface ISlotConfigChoice {
	preset: LayoutPresetId;
	assignments: Partial<Record<SlotPositionKey, SlotSourceId>>;
}

interface IDragState {
	/** Source being dragged. */
	sourceId: SlotSourceId;
	/** Position the chip was dragged from (null = came from the tray). */
	fromPosition: SlotPositionKey | null;
	/** Ghost element following the cursor. */
	ghost: HTMLElement;
}

// ---------------------------------------------------------------------------
// SlotConfigOverlay
// ---------------------------------------------------------------------------

/**
 * Full-bubble configuration overlay.
 *
 * Phase 1 — preset selection: shows 5 named layout tiles.
 * Phase 2 — assignment: drag data-source chips into labelled drop zones.
 *
 * Fades in on open and out on close. Disposes itself after fade-out completes.
 */
export class SlotConfigOverlay extends Disposable {
	private readonly _element: HTMLElement;
	private readonly _presetPhase: HTMLElement;
	private readonly _assignPhase: HTMLElement;
	private readonly _innerDisposables = this._register(new DisposableStore());

	private readonly _onDidConfirm = this._register(
		new Emitter<ISlotConfigChoice>(),
	);
	private readonly _onDidCancel = this._register(new Emitter<void>());

	/** Fires when the user confirms a new layout. */
	readonly onDidConfirm: Event<ISlotConfigChoice> = this._onDidConfirm.event;

	/** Fires when the user cancels. */
	readonly onDidCancel: Event<void> = this._onDidCancel.event;

	private _selectedPreset: LayoutPresetId;
	/** Working copy of assignments — not persisted until confirm. */
	private _pendingAssignments: Map<SlotPositionKey, SlotSourceId | undefined>;
	private _dragState: IDragState | null = null;
	private _closed = false;

	// References to assignment-phase elements rebuilt on each phase entry
	private _zoneGrid: HTMLElement | null = null;
	private _trayEl: HTMLElement | null = null;
	// Per-zone elements keyed by position
	private _zoneElements = new Map<SlotPositionKey, HTMLElement>();
	// Direct references to preset tile sub-elements — avoids querySelector
	private _presetTileElements = new Map<
		LayoutPresetId,
		{ tile: HTMLElement; preview: HTMLElement; label: HTMLElement }
	>();

	constructor(
		/** The bubble widget's root element — overlay is appended here. */
		container: HTMLElement,
		initialConfig: ISlotConfig,
	) {
		super();
		ensureOverlayStyles();

		this._selectedPreset = initialConfig.preset;
		this._pendingAssignments = new Map<
			SlotPositionKey,
			SlotSourceId | undefined
		>(
			SLOT_POSITION_KEYS.map(
				(k) =>
					[k, initialConfig.assignments[k]] as [
						SlotPositionKey,
						SlotSourceId | undefined,
					],
			),
		);

		this._presetPhase = this._buildPresetPhase();
		this._assignPhase = this._buildAssignPhase();
		this._element = this._buildRoot();
		container.appendChild(this._element);

		// Fade in on next frame so the transition plays
		mainWindow.requestAnimationFrame(() =>
			this._element.classList.add('is-visible'),
		);
	}

	// -------------------------------------------------------------------------
	// DOM construction
	// -------------------------------------------------------------------------

	private _buildRoot(): HTMLElement {
		const root = document.createElement('div');
		root.className = 'cbo-overlay';
		root.appendChild(this._presetPhase);
		root.appendChild(this._assignPhase);
		this._presetPhase.classList.add('is-active');
		return root;
	}

	private _buildPresetPhase(): HTMLElement {
		const phase = document.createElement('div');
		phase.className = 'cbo-phase';

		const title = document.createElement('div');
		title.className = 'cbo-phase-title';
		title.textContent = nls.localize('slotConfig.chooseLayout', "Choose a Layout");
		phase.appendChild(title);

		const grid = document.createElement('div');
		grid.className = 'cbo-preset-grid';
		phase.appendChild(grid);

		for (const presetId of ALL_PRESETS) {
			grid.appendChild(this._buildPresetTile(presetId));
		}

		const actions = document.createElement('div');
		actions.className = 'cbo-actions';
		actions.appendChild(this._buildBtn(nls.localize('slotConfig.cancel', "Cancel"), false, () => this._cancel()));
		actions.appendChild(
			this._buildBtn(nls.localize('slotConfig.next', "Next \u2192"), true, () => this._enterAssignPhase()),
		);
		phase.appendChild(actions);

		return phase;
	}

	private _buildPresetTile(presetId: LayoutPresetId): HTMLElement {
		const tile = document.createElement('div');
		tile.className = 'cbo-preset-tile';
		if (presetId === this._selectedPreset) {
			tile.classList.add('is-selected');
		}
		tile.dataset['preset'] = presetId;

		const preview = document.createElement('div');
		preview.className = 'cbo-preset-preview';
		preview.style.color =
			presetId === this._selectedPreset
				? 'rgba(78, 201, 176, 0.75)'
				: 'rgba(130, 150, 168, 0.55)';
		preview.appendChild(buildPresetSvg(presetId));

		const label = document.createElement('div');
		label.className = 'cbo-preset-label';
		label.textContent = PRESET_LABELS[presetId];
		label.style.whiteSpace = 'pre-line';

		tile.appendChild(preview);
		tile.appendChild(label);

		// Store direct references so _selectPreset can update them without querySelector
		this._presetTileElements.set(presetId, { tile, preview, label });

		this._innerDisposables.add(
			dom.addDisposableListener(tile, 'click', () => {
				this._selectPreset(presetId);
			}),
		);

		return tile;
	}

	private _buildAssignPhase(): HTMLElement {
		const phase = document.createElement('div');
		phase.className = 'cbo-phase';

		const title = document.createElement('div');
		title.className = 'cbo-phase-title';
		title.textContent = nls.localize('slotConfig.assignSources', "Assign Sources");
		phase.appendChild(title);

		// Zone grid and tray are rebuilt each time we enter this phase
		this._zoneGrid = document.createElement('div');
		this._zoneGrid.className = 'cbo-zone-grid';
		phase.appendChild(this._zoneGrid);

		this._trayEl = document.createElement('div');
		this._trayEl.className = 'cbo-tray';
		phase.appendChild(this._trayEl);

		const actions = document.createElement('div');
		actions.className = 'cbo-actions';

		const backBtn = this._buildBtn(nls.localize('slotConfig.back', "\u2190 Back"), false, () =>
			this._enterPresetPhase(),
		);
		backBtn.classList.add('cbo-btn-back');
		actions.appendChild(backBtn);
		actions.appendChild(this._buildBtn(nls.localize('slotConfig.cancel', "Cancel"), false, () => this._cancel()));
		actions.appendChild(this._buildBtn(nls.localize('slotConfig.confirm', "Confirm"), true, () => this._confirm()));
		phase.appendChild(actions);

		return phase;
	}

	private _buildBtn(
		label: string,
		primary: boolean,
		handler: () => void,
	): HTMLElement {
		const btn = document.createElement('button');
		btn.className = primary ? 'cbo-btn cbo-btn-primary' : 'cbo-btn';
		btn.textContent = label;
		this._innerDisposables.add(
			dom.addDisposableListener(btn, 'click', (e) => {
				e.stopPropagation();
				handler();
			}),
		);
		return btn;
	}

	// -------------------------------------------------------------------------
	// Preset selection
	// -------------------------------------------------------------------------

	private _selectPreset(presetId: LayoutPresetId): void {
		this._selectedPreset = presetId;

		// Update tile highlight using direct element references
		for (const [id, els] of this._presetTileElements) {
			const isSelected = id === presetId;
			els.tile.classList.toggle('is-selected', isSelected);
			els.preview.style.color = isSelected
				? 'rgba(78, 201, 176, 0.75)'
				: 'rgba(130, 150, 168, 0.55)';
			els.label.style.color = '';
		}

		// Trim assignments that don't fit the new preset's positions
		const allowedPositions = PRESET_POSITIONS[presetId];
		for (const [pos, src] of this._pendingAssignments) {
			if (!allowedPositions.includes(pos) && src !== undefined) {
				this._pendingAssignments.set(pos, undefined);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Phase transitions
	// -------------------------------------------------------------------------

	private _enterPresetPhase(): void {
		this._assignPhase.classList.remove('is-active');
		this._presetPhase.classList.add('is-active');
	}

	private _enterAssignPhase(): void {
		this._presetPhase.classList.remove('is-active');
		this._assignPhase.classList.add('is-active');
		this._rebuildAssignView();
	}

	// -------------------------------------------------------------------------
	// Assignment view (rebuilt on demand)
	// -------------------------------------------------------------------------

	private _rebuildAssignView(): void {
		if (!this._zoneGrid || !this._trayEl) {
			return;
		}

		// Rebuild zone grid
		while (this._zoneGrid.firstChild) {
			this._zoneGrid.removeChild(this._zoneGrid.firstChild);
		}
		this._zoneElements.clear();
		this._zoneGrid.dataset['preset'] = this._selectedPreset;

		const activePositions = PRESET_POSITIONS[this._selectedPreset];
		for (const posKey of SLOT_POSITION_KEYS) {
			if (!activePositions.includes(posKey)) {
				continue;
			}
			const zone = this._buildDropZone(posKey);
			this._zoneElements.set(posKey, zone);
			this._zoneGrid.appendChild(zone);
		}

		// Rebuild tray
		while (this._trayEl.firstChild) {
			this._trayEl.removeChild(this._trayEl.firstChild);
		}
		const trayLabel = document.createElement('span');
		trayLabel.className = 'cbo-tray-label';
		trayLabel.textContent = nls.localize('slotConfig.sources', "Sources");
		this._trayEl.appendChild(trayLabel);

		const assignedSources = new Set(
			[...this._pendingAssignments.values()].filter(
				(v): v is SlotSourceId => v !== undefined,
			),
		);
		for (const sourceId of ALL_SOURCE_IDS) {
			if (!assignedSources.has(sourceId)) {
				this._trayEl.appendChild(this._buildTrayChip(sourceId));
			}
		}
	}

	private _buildDropZone(posKey: SlotPositionKey): HTMLElement {
		const zone = document.createElement('div');
		zone.className = 'cbo-drop-zone';
		zone.dataset['position'] = posKey;

		const posLabel = document.createElement('div');
		posLabel.className = 'cbo-zone-position-label';
		posLabel.textContent = POSITION_LABELS[posKey];
		zone.appendChild(posLabel);

		const assigned = this._pendingAssignments.get(posKey);
		if (assigned) {
			zone.appendChild(this._buildZoneChip(assigned, posKey));
		} else {
			const hint = document.createElement('div');
			hint.className = 'cbo-empty-hint';
			hint.textContent = nls.localize('slotConfig.dropHere', "Drop here");
			zone.appendChild(hint);
		}

		// dragover highlight
		this._innerDisposables.add(
			dom.addDisposableListener(zone, 'mouseenter', () => {
				if (this._dragState) {
					zone.classList.add('drag-over');
				}
			}),
		);
		this._innerDisposables.add(
			dom.addDisposableListener(zone, 'mouseleave', () => {
				zone.classList.remove('drag-over');
			}),
		);

		return zone;
	}

	private _buildZoneChip(
		sourceId: SlotSourceId,
		posKey: SlotPositionKey,
	): HTMLElement {
		const chip = document.createElement('div');
		chip.className = 'cbo-zone-chip';
		chip.textContent = SOURCE_LABELS[sourceId];

		this._innerDisposables.add(
			dom.addDisposableListener(chip, 'mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._startDrag(sourceId, posKey, e);
			}),
		);

		return chip;
	}

	private _buildTrayChip(sourceId: SlotSourceId): HTMLElement {
		const chip = document.createElement('div');
		chip.className = 'cbo-tray-chip';
		chip.textContent = SOURCE_LABELS[sourceId];

		this._innerDisposables.add(
			dom.addDisposableListener(chip, 'mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._startDrag(sourceId, null, e);
			}),
		);

		return chip;
	}

	// -------------------------------------------------------------------------
	// Drag-and-drop (mouse-based)
	// -------------------------------------------------------------------------

	private _startDrag(
		sourceId: SlotSourceId,
		fromPosition: SlotPositionKey | null,
		e: MouseEvent,
	): void {
		const ghost = document.createElement('div');
		ghost.className = 'cbo-drag-ghost';
		ghost.textContent = SOURCE_LABELS[sourceId];
		ghost.style.left = `${e.clientX}px`;
		ghost.style.top = `${e.clientY}px`;
		mainWindow.document.body.appendChild(ghost);

		this._dragState = { sourceId, fromPosition, ghost };

		const win = dom.getWindow(this._element);
		const moveDisposable = dom.addDisposableListener(win, 'mousemove', (mv) => {
			ghost.style.left = `${mv.clientX}px`;
			ghost.style.top = `${mv.clientY}px`;
		});
		const upDisposable = dom.addDisposableListener(win, 'mouseup', (mv) => {
			moveDisposable.dispose();
			upDisposable.dispose();
			this._endDrag(mv);
		});
	}

	private _endDrag(e: MouseEvent): void {
		if (!this._dragState) {
			return;
		}
		const { sourceId, fromPosition, ghost } = this._dragState;
		this._dragState = null;
		ghost.remove();

		// Clear all drag-over highlights
		for (const zone of this._zoneElements.values()) {
			zone.classList.remove('drag-over');
		}

		// Find which zone the mouse is over
		const targetPosition = this._hitTestZone(e.clientX, e.clientY);

		if (targetPosition !== null) {
			this._doAssign(sourceId, fromPosition, targetPosition);
		} else {
			// Dropped outside any zone: return to tray (unassign from position)
			if (fromPosition !== null) {
				this._pendingAssignments.set(fromPosition, undefined);
				this._rebuildAssignView();
			}
		}
	}

	private _hitTestZone(
		clientX: number,
		clientY: number,
	): SlotPositionKey | null {
		for (const [posKey, zoneEl] of this._zoneElements) {
			const rect = zoneEl.getBoundingClientRect();
			if (
				clientX >= rect.left &&
				clientX <= rect.right &&
				clientY >= rect.top &&
				clientY <= rect.bottom
			) {
				return posKey;
			}
		}
		return null;
	}

	/**
	 * Assigns `sourceId` to `targetPosition`, intelligently swapping if
	 * the target position is already occupied.
	 */
	private _doAssign(
		sourceId: SlotSourceId,
		fromPosition: SlotPositionKey | null,
		targetPosition: SlotPositionKey,
	): void {
		const displaced = this._pendingAssignments.get(targetPosition);

		// Place the dragged source in the target zone
		this._pendingAssignments.set(targetPosition, sourceId);

		// Swap: if dragged from a zone and target was occupied, give the
		// displaced source the origin zone; otherwise it returns to the tray.
		if (fromPosition !== null) {
			this._pendingAssignments.set(fromPosition, displaced ?? undefined);
		}
		// If dragged from tray and target was occupied, displaced returns to tray
		// (no explicit action needed — it won't appear in assignedSources during rebuild)

		this._rebuildAssignView();
	}

	// -------------------------------------------------------------------------
	// Confirm / Cancel / Close
	// -------------------------------------------------------------------------

	private _confirm(): void {
		const assignments: Partial<Record<SlotPositionKey, SlotSourceId>> = {};
		for (const [posKey, sourceId] of this._pendingAssignments) {
			if (sourceId !== undefined) {
				assignments[posKey] = sourceId;
			}
		}
		this._onDidConfirm.fire({ preset: this._selectedPreset, assignments });
		this._close();
	}

	private _cancel(): void {
		this._onDidCancel.fire();
		this._close();
	}

	private _close(): void {
		this._element.classList.remove('is-visible');
		const onTransitionEnd = dom.addDisposableListener(
			this._element,
			'transitionend',
			() => {
				onTransitionEnd.dispose();
				this.dispose();
			},
		);
		// Safety: if the transition doesn't fire (e.g. reduced motion), still dispose
		setTimeout(() => {
			onTransitionEnd.dispose();
			if (!this._closed) {
				this.dispose();
			}
		}, 300);
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		this._closed = true;
		this._element.remove();
		super.dispose();
	}
}
