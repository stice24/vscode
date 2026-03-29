/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum allowed bubble width in pixels. */
const MIN_WIDTH = 320;

/** Minimum allowed bubble height in pixels. */
const MIN_HEIGHT = 280;

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 460;

/**
 * Z-index above the editor surface (suggest: 40, arrow: 49) but
 * below notifications / dialogs (10000+).
 */
const BUBBLE_Z_INDEX = 50;

// ---------------------------------------------------------------------------
// Style injection — runs once per page lifetime
// ---------------------------------------------------------------------------

let _widgetStylesInjected = false;

function ensureWidgetStyles(): void {
	if (_widgetStylesInjected) {
		return;
	}
	_widgetStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `

/* ---- Root widget ---- */
.context-bubble-widget {
	position: absolute;
	z-index: ${BUBBLE_Z_INDEX};
	display: none;
	flex-direction: column;
	background: linear-gradient(180deg, #111318 0%, #0d0f12 100%);
	border-radius: 14px;
	box-shadow:
		0 0 0 1px rgba(80, 200, 220, 0.13),
		0 2px 10px rgba(0, 0, 0, 0.65),
		0 16px 52px rgba(0, 0, 0, 0.55);
	overflow: hidden;
	user-select: none;
	box-sizing: border-box;
	transition: box-shadow 0.2s ease;
}
.context-bubble-widget.is-hovered {
	box-shadow:
		0 0 0 1px rgba(80, 200, 220, 0.28),
		0 2px 10px rgba(0, 0, 0, 0.65),
		0 16px 52px rgba(0, 0, 0, 0.55);
}
.context-bubble-widget.is-dragging {
	box-shadow:
		0 0 0 1px rgba(80, 200, 220, 0.42),
		0 0 24px rgba(80, 200, 220, 0.07),
		0 6px 20px rgba(0, 0, 0, 0.75),
		0 24px 64px rgba(0, 0, 0, 0.6);
	transition: none;
}

/* ---- Chrome bar ---- */
.context-bubble-chrome {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 7px 12px;
	background: rgba(20, 23, 30, 0.98);
	border-bottom: 1px solid rgba(80, 200, 220, 0.07);
	cursor: move;
	flex-shrink: 0;
	gap: 8px;
}

.context-bubble-title {
	font-size: 10px;
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: rgba(180, 190, 200, 0.45);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	flex: 1;
	font-family: system-ui, -apple-system, sans-serif;
}

.context-bubble-controls {
	display: flex;
	gap: 2px;
	flex-shrink: 0;
}

.context-bubble-btn-hide,
.context-bubble-btn-close {
	background: none;
	border: none;
	cursor: pointer;
	color: rgba(210, 220, 230, 0.95);
	font-size: 14px;
	line-height: 1;
	padding: 2px 5px;
	border-radius: 3px;
	opacity: 0.45;
	transition: opacity 0.15s, background 0.1s;
}
.context-bubble-widget.is-hovered .context-bubble-btn-hide,
.context-bubble-widget.is-hovered .context-bubble-btn-close {
	opacity: 0.85;
}
.context-bubble-btn-hide:hover,
.context-bubble-btn-close:hover {
	opacity: 1 !important;
	background: rgba(255, 255, 255, 0.1);
}

/* ---- Slots container ---- */
.context-bubble-slots {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	min-height: 0;
	-webkit-mask-image:
		linear-gradient(to right, transparent 0px, black 10px, black calc(100% - 10px), transparent 100%),
		linear-gradient(to bottom, black 0%, black calc(100% - 26px), transparent 100%);
	-webkit-mask-composite: destination-in;
	mask-image:
		linear-gradient(to right, transparent 0px, black 10px, black calc(100% - 10px), transparent 100%),
		linear-gradient(to bottom, black 0%, black calc(100% - 26px), transparent 100%);
	mask-composite: intersect;
}

/* ---- Slot dividers (gradient separator between adjacent slots) ---- */
.context-bubble-slot + .context-bubble-slot::before {
	content: '';
	display: block;
	height: 1px;
	flex-shrink: 0;
	background: linear-gradient(
		to right,
		transparent 0%,
		rgba(80, 200, 220, 0.18) 20%,
		rgba(80, 200, 220, 0.18) 80%,
		transparent 100%
	);
}

/* ---- Slot label (used by SlotComponent subclasses) ---- */
.slot-label {
	font-size: 9px;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: rgba(180, 190, 200, 0.3);
	padding: 7px 14px 3px;
	font-family: system-ui, -apple-system, sans-serif;
	flex-shrink: 0;
}

/* ---- Resize handles ---- */
.context-bubble-resize-handle {
	position: absolute;
	opacity: 0;
	z-index: 2;
	transition: opacity 0.15s;
}
.context-bubble-widget.is-border-hovered .context-bubble-resize-handle {
	opacity: 1;
}
/* Cyan tint on active resize handle */
.context-bubble-resize-handle:active {
	background: rgba(80, 200, 220, 0.12) !important;
	opacity: 1 !important;
}

/* ---- Preset layout variants on the slots container ---- */

.context-bubble-slots[data-preset="horizontal3"] {
	flex-direction: row;
}
.context-bubble-slots[data-preset="largeBottom"] {
	display: grid;
	grid-template-columns: 1fr 1fr;
	grid-template-rows: 1fr 2fr;
}
.context-bubble-slots[data-preset="largeBottom"] > .context-bubble-slot:nth-child(3) {
	grid-column: 1 / 3;
	border-top: 1px solid rgba(80, 200, 220, 0.1);
}
.context-bubble-slots[data-preset="largeTop"] {
	display: grid;
	grid-template-columns: 1fr 1fr;
	grid-template-rows: 2fr 1fr;
}
.context-bubble-slots[data-preset="largeTop"] > .context-bubble-slot:first-child {
	grid-column: 1 / 3;
	border-bottom: 1px solid rgba(80, 200, 220, 0.1);
}

/* ---- Config button in chrome ---- */
.context-bubble-btn-config {
	background: none;
	border: none;
	cursor: pointer;
	color: rgba(210, 220, 230, 0.95);
	font-size: 13px;
	line-height: 1;
	padding: 2px 5px;
	border-radius: 3px;
	opacity: 0.38;
	transition: opacity 0.15s, background 0.1s;
}
.context-bubble-widget.is-hovered .context-bubble-btn-config {
	opacity: 0.72;
}
.context-bubble-btn-config:hover {
	opacity: 1 !important;
	background: rgba(80, 200, 220, 0.12);
}

`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

const ALL_RESIZE_HANDLES: ResizeHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

interface IDragState {
	startMouseX: number;
	startMouseY: number;
	startElemX: number;
	startElemY: number;
}

interface IResizeState {
	startMouseX: number;
	startMouseY: number;
	startWidth: number;
	startHeight: number;
	startX: number;
	startY: number;
	handle: ResizeHandle;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

/**
 * A floating, draggable, resizable context bubble widget.
 *
 * Mounts as a custom DOM element directly in the workbench container.
 * Does NOT extend any existing overlay widget (HoverWidget, SuggestWidget, …).
 *
 * Drag and resize position updates are applied directly to `element.style` in
 * the `mousemove` handler — there is no state-update cycle in the hot path.
 */
export class ContextBubbleWidget extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _slotsContainer: HTMLElement;
	private readonly _resizeHandleElements: HTMLElement[] = [];
	private readonly _disposables = this._register(new DisposableStore());

	private readonly _onDidMove = this._register(new Emitter<void>());
	private readonly _onDidClose = this._register(new Emitter<void>());
	private readonly _onDidInteract = this._register(new Emitter<void>());
	private readonly _onDidRequestConfig = this._register(new Emitter<void>());

	/** Fires on every `mousemove` during a drag — use to update the arrow. */
	readonly onDidMove: Event<void> = this._onDidMove.event;

	/** Fires when the user closes the bubble via the "×" button. */
	readonly onDidClose: Event<void> = this._onDidClose.event;

	/** Fires on any `mousedown` on the bubble element. */
	readonly onDidInteract: Event<void> = this._onDidInteract.event;

	/** Fires when the user clicks the configuration (gear) button. */
	readonly onDidRequestConfig: Event<void> = this._onDidRequestConfig.event;

	private _x = 100;
	private _y = 100;
	private _width = DEFAULT_WIDTH;
	private _height = DEFAULT_HEIGHT;
	private _visible = false;

	private _dragState: IDragState | null = null;
	private _resizeState: IResizeState | null = null;

	constructor(private readonly _container: HTMLElement) {
		super();
		ensureWidgetStyles();
		this._slotsContainer = this._buildSlotsContainer();
		this._element = this._buildElement();
		this._container.appendChild(this._element);
		this._bindHover();
		this._bindBorderHover();
		this._bindInteract();
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/** Make the bubble visible at its current position. */
	show(): void {
		this._visible = true;
		this._element.style.display = 'flex';
	}

	/**
	 * Collapse to hidden state.
	 * Position and slot data are preserved in memory.
	 * The gutter anchor remains visible.
	 */
	hide(): void {
		this._visible = false;
		this._element.style.display = 'none';
	}

	/**
	 * Destroy the bubble entirely — fires `onDidClose` before disposal.
	 * Removes the DOM element and disposes all listeners.
	 */
	close(): void {
		this._onDidClose.fire();
		this.dispose();
	}

	/** Move the bubble to the given workbench-container-relative coordinates. */
	setPosition(x: number, y: number): void {
		this._x = x;
		this._y = y;
		this._element.style.left = `${x}px`;
		this._element.style.top = `${y}px`;
	}

	/** Current container-relative position. */
	getPosition(): { x: number; y: number } {
		return { x: this._x, y: this._y };
	}

	get isVisible(): boolean {
		return this._visible;
	}

	get element(): HTMLElement {
		return this._element;
	}

	/** The element that SlotComponent subclasses should append themselves to. */
	getSlotsContainer(): HTMLElement {
		return this._slotsContainer;
	}

	// -------------------------------------------------------------------------
	// DOM construction
	// -------------------------------------------------------------------------

	private _buildElement(): HTMLElement {
		const root = document.createElement('div');
		root.className = 'context-bubble-widget';
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-label', 'Context Bubble');
		// Dynamic properties only — visual styles come from the injected stylesheet
		root.style.cssText = [
			`left: ${this._x}px`,
			`top: ${this._y}px`,
			`width: ${this._width}px`,
			`height: ${this._height}px`,
		].join('; ');

		root.appendChild(this._buildChrome());
		root.appendChild(this._slotsContainer);

		for (const handle of ALL_RESIZE_HANDLES) {
			const el = this._buildResizeHandle(handle);
			this._resizeHandleElements.push(el);
			root.appendChild(el);
		}

		return root;
	}

	private _buildChrome(): HTMLElement {
		const chrome = document.createElement('div');
		chrome.className = 'context-bubble-chrome';

		const title = document.createElement('span');
		title.className = 'context-bubble-title';
		title.textContent = 'Context Bubble';

		const controls = document.createElement('span');
		controls.className = 'context-bubble-controls';

		controls.appendChild(this._buildChromeButton('\u2699', 'context-bubble-btn-config', () => this._onDidRequestConfig.fire()));
		controls.appendChild(this._buildChromeButton('\u2212', 'context-bubble-btn-hide', () => this.hide()));
		controls.appendChild(this._buildChromeButton('\u00d7', 'context-bubble-btn-close', () => this.close()));

		chrome.appendChild(title);
		chrome.appendChild(controls);

		this._disposables.add(dom.addDisposableListener(chrome, 'mousedown', e => this._onDragStart(e)));

		return chrome;
	}

	private _buildChromeButton(label: string, className: string, handler: () => void): HTMLElement {
		const btn = document.createElement('button');
		btn.className = className;
		btn.textContent = label;
		this._disposables.add(dom.addDisposableListener(btn, 'click', e => {
			e.stopPropagation();
			handler();
		}));
		return btn;
	}

	private _buildSlotsContainer(): HTMLElement {
		const el = document.createElement('div');
		el.className = 'context-bubble-slots';
		return el;
	}

	private _buildResizeHandle(handle: ResizeHandle): HTMLElement {
		const el = document.createElement('div');
		el.className = `context-bubble-resize-handle context-bubble-resize-${handle}`;
		el.dataset['handle'] = handle;

		const cursorMap: Record<ResizeHandle, string> = {
			n: 'n-resize', ne: 'ne-resize', e: 'e-resize', se: 'se-resize',
			s: 's-resize', sw: 'sw-resize', w: 'w-resize', nw: 'nw-resize',
		};

		const t = 6;
		const positionMap: Record<ResizeHandle, string> = {
			n: `top: 0; left: ${t}px; right: ${t}px; height: ${t}px;`,
			s: `bottom: 0; left: ${t}px; right: ${t}px; height: ${t}px;`,
			e: `right: 0; top: ${t}px; bottom: ${t}px; width: ${t}px;`,
			w: `left: 0; top: ${t}px; bottom: ${t}px; width: ${t}px;`,
			nw: `top: 0; left: 0; width: ${t * 2}px; height: ${t * 2}px;`,
			ne: `top: 0; right: 0; width: ${t * 2}px; height: ${t * 2}px;`,
			se: `bottom: 0; right: 0; width: ${t * 2}px; height: ${t * 2}px;`,
			sw: `bottom: 0; left: 0; width: ${t * 2}px; height: ${t * 2}px;`,
		};
		const positionStyle = positionMap[handle];

		el.style.cssText = [`cursor: ${cursorMap[handle]}`, positionStyle].join('; ');

		this._disposables.add(dom.addDisposableListener(el, 'mousedown', e => this._onResizeStart(e, handle)));

		return el;
	}

	// -------------------------------------------------------------------------
	// Hover / state management
	// -------------------------------------------------------------------------

	private _bindHover(): void {
		this._disposables.add(dom.addDisposableListener(this._element, 'mouseenter', () => {
			this._element.classList.add('is-hovered');
		}));
		this._disposables.add(dom.addDisposableListener(this._element, 'mouseleave', () => {
			this._element.classList.remove('is-hovered');
		}));
	}

	private _bindBorderHover(): void {
		this._disposables.add(dom.addDisposableListener(this._element, 'mousemove', e => {
			const rect = this._element.getBoundingClientRect();
			const edgeThreshold = 10;
			const nearEdge =
				e.clientX - rect.left < edgeThreshold ||
				rect.right - e.clientX < edgeThreshold ||
				e.clientY - rect.top < edgeThreshold ||
				rect.bottom - e.clientY < edgeThreshold;
			this._element.classList.toggle('is-border-hovered', nearEdge);
		}));
		this._disposables.add(dom.addDisposableListener(this._element, 'mouseleave', () => {
			this._element.classList.remove('is-border-hovered');
		}));
	}

	private _bindInteract(): void {
		// Any mousedown on the widget is an "interaction" — used to dismiss the arrow
		this._disposables.add(dom.addDisposableListener(this._element, 'mousedown', () => {
			this._onDidInteract.fire();
		}));
	}

	// -------------------------------------------------------------------------
	// Drag
	// -------------------------------------------------------------------------

	private _onDragStart(e: MouseEvent): void {
		if (e.button !== 0) {
			return;
		}
		e.preventDefault();
		this._dragState = {
			startMouseX: e.clientX,
			startMouseY: e.clientY,
			startElemX: this._x,
			startElemY: this._y,
		};
		this._element.classList.add('is-dragging');

		const win = dom.getWindow(this._element);
		const moveDisposable = dom.addDisposableListener(win, 'mousemove', mv => this._onDragMove(mv));
		const upDisposable = dom.addDisposableListener(win, 'mouseup', () => {
			this._dragState = null;
			this._element.classList.remove('is-dragging');
			moveDisposable.dispose();
			upDisposable.dispose();
		});
	}

	private _onDragMove(e: MouseEvent): void {
		if (!this._dragState) {
			return;
		}
		const dx = e.clientX - this._dragState.startMouseX;
		const dy = e.clientY - this._dragState.startMouseY;
		this._x = this._dragState.startElemX + dx;
		this._y = this._dragState.startElemY + dy;
		// Direct style mutation — no state-update cycle in the hot path
		this._element.style.left = `${this._x}px`;
		this._element.style.top = `${this._y}px`;
		this._onDidMove.fire();
	}

	// -------------------------------------------------------------------------
	// Resize
	// -------------------------------------------------------------------------

	private _onResizeStart(e: MouseEvent, handle: ResizeHandle): void {
		if (e.button !== 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this._resizeState = {
			startMouseX: e.clientX,
			startMouseY: e.clientY,
			startWidth: this._width,
			startHeight: this._height,
			startX: this._x,
			startY: this._y,
			handle,
		};

		const win = dom.getWindow(this._element);
		const moveDisposable = dom.addDisposableListener(win, 'mousemove', mv => this._onResizeMove(mv));
		const upDisposable = dom.addDisposableListener(win, 'mouseup', () => {
			this._resizeState = null;
			moveDisposable.dispose();
			upDisposable.dispose();
		});
	}

	private _onResizeMove(e: MouseEvent): void {
		if (!this._resizeState) {
			return;
		}
		const { startMouseX, startMouseY, startWidth, startHeight, startX, startY, handle } = this._resizeState;
		const dx = e.clientX - startMouseX;
		const dy = e.clientY - startMouseY;

		let newWidth = startWidth;
		let newHeight = startHeight;
		let newX = startX;
		let newY = startY;

		if (handle.includes('e')) {
			newWidth = Math.max(MIN_WIDTH, startWidth + dx);
		}
		if (handle.includes('w')) {
			const proposed = startWidth - dx;
			if (proposed >= MIN_WIDTH) {
				newWidth = proposed;
				newX = startX + dx;
			}
		}
		if (handle.includes('s')) {
			newHeight = Math.max(MIN_HEIGHT, startHeight + dy);
		}
		if (handle.includes('n')) {
			const proposed = startHeight - dy;
			if (proposed >= MIN_HEIGHT) {
				newHeight = proposed;
				newY = startY + dy;
			}
		}

		this._width = newWidth;
		this._height = newHeight;
		this._x = newX;
		this._y = newY;

		// Direct style mutation — no state-update cycle in the hot path
		this._element.style.width = `${newWidth}px`;
		this._element.style.height = `${newHeight}px`;
		this._element.style.left = `${newX}px`;
		this._element.style.top = `${newY}px`;
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		this._element.remove();
		super.dispose();
	}
}
