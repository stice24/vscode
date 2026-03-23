/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import * as dom from '../../../../base/browser/dom.js';

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
 * Z-index that places the bubble above the editor surface (suggest: 40) but
 * below notifications / dialogs (10000+).
 */
const BUBBLE_Z_INDEX = 50;

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

	private _x = 100;
	private _y = 100;
	private _width = DEFAULT_WIDTH;
	private _height = DEFAULT_HEIGHT;
	private _visible = false;

	private _dragState: IDragState | null = null;
	private _resizeState: IResizeState | null = null;

	constructor(private readonly _container: HTMLElement) {
		super();
		this._slotsContainer = this._buildSlotsContainer();
		this._element = this._buildElement();
		this._container.appendChild(this._element);
		this._bindBorderHover();
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
	 * The gutter anchor (added in a later session) remains visible.
	 */
	hide(): void {
		this._visible = false;
		this._element.style.display = 'none';
	}

	/**
	 * Destroy the bubble entirely.
	 * Removes the DOM element and disposes all listeners.
	 */
	close(): void {
		this.dispose();
	}

	/** Move the bubble to the given workbench-container-relative coordinates. */
	setPosition(x: number, y: number): void {
		this._x = x;
		this._y = y;
		this._element.style.left = `${x}px`;
		this._element.style.top = `${y}px`;
	}

	get isVisible(): boolean {
		return this._visible;
	}

	get element(): HTMLElement {
		return this._element;
	}

	/** The element that slot components should append themselves to. */
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
		root.style.cssText = [
			'position: absolute',
			`left: ${this._x}px`,
			`top: ${this._y}px`,
			`width: ${this._width}px`,
			`height: ${this._height}px`,
			`z-index: ${BUBBLE_Z_INDEX}`,
			'display: none',
			'flex-direction: column',
			'background: var(--vscode-editorWidget-background, #1e1e1e)',
			'border: 1px solid var(--vscode-editorWidget-border, #454545)',
			'border-radius: 6px',
			'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4)',
			'overflow: hidden',
			'user-select: none',
			'box-sizing: border-box',
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
		chrome.style.cssText = [
			'display: flex',
			'align-items: center',
			'justify-content: space-between',
			'padding: 6px 10px',
			'background: var(--vscode-titleBar-activeBackground, #3c3c3c)',
			'cursor: move',
			'flex-shrink: 0',
			'gap: 8px',
		].join('; ');

		const title = document.createElement('span');
		title.className = 'context-bubble-title';
		title.textContent = 'Context Bubble';
		title.style.cssText = [
			'font-size: 12px',
			'font-weight: 600',
			'color: var(--vscode-foreground, #cccccc)',
			'white-space: nowrap',
			'overflow: hidden',
			'text-overflow: ellipsis',
			'flex: 1',
		].join('; ');

		const controls = document.createElement('span');
		controls.className = 'context-bubble-controls';
		controls.style.cssText = 'display: flex; gap: 4px; flex-shrink: 0;';

		controls.appendChild(this._buildChromeButton('\u2212', 'context-bubble-btn-hide', () => this.hide()));
		controls.appendChild(this._buildChromeButton('\u00d7', 'context-bubble-btn-close', () => this.close()));

		chrome.appendChild(title);
		chrome.appendChild(controls);

		// Drag is initiated from the chrome bar
		this._disposables.add(dom.addDisposableListener(chrome, 'mousedown', e => this._onDragStart(e)));

		return chrome;
	}

	private _buildChromeButton(label: string, className: string, handler: () => void): HTMLElement {
		const btn = document.createElement('button');
		btn.className = className;
		btn.textContent = label;
		btn.style.cssText = [
			'background: none',
			'border: none',
			'cursor: pointer',
			'color: var(--vscode-foreground, #cccccc)',
			'font-size: 14px',
			'line-height: 1',
			'padding: 2px 4px',
			'opacity: 0.7',
			'border-radius: 3px',
		].join('; ');
		this._disposables.add(dom.addDisposableListener(btn, 'click', e => {
			e.stopPropagation();
			handler();
		}));
		return btn;
	}

	private _buildSlotsContainer(): HTMLElement {
		const el = document.createElement('div');
		el.className = 'context-bubble-slots';
		el.style.cssText = [
			'flex: 1',
			'display: flex',
			'flex-direction: column',
			'overflow: hidden',
			'min-height: 0',
		].join('; ');
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

		const t = 6;  // thickness / corner size in pixels

		const positionStyle =
			handle === 'n' ? `top: 0; left: ${t}px; right: ${t}px; height: ${t}px;` :
				handle === 's' ? `bottom: 0; left: ${t}px; right: ${t}px; height: ${t}px;` :
					handle === 'e' ? `right: 0; top: ${t}px; bottom: ${t}px; width: ${t}px;` :
						handle === 'w' ? `left: 0; top: ${t}px; bottom: ${t}px; width: ${t}px;` :
							handle === 'nw' ? `top: 0; left: 0; width: ${t * 2}px; height: ${t * 2}px;` :
								handle === 'ne' ? `top: 0; right: 0; width: ${t * 2}px; height: ${t * 2}px;` :
									handle === 'se' ? `bottom: 0; right: 0; width: ${t * 2}px; height: ${t * 2}px;` :
			/* sw */          `bottom: 0; left: 0; width: ${t * 2}px; height: ${t * 2}px;`;

		el.style.cssText = [
			'position: absolute',
			`cursor: ${cursorMap[handle]}`,
			'opacity: 0',
			'transition: opacity 0.15s',
			'z-index: 2',
			positionStyle,
		].join('; ');

		this._disposables.add(dom.addDisposableListener(el, 'mousedown', e => this._onResizeStart(e, handle)));

		return el;
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

		const win = dom.getWindow(this._element);
		// Temporary listeners are NOT registered to _disposables — they self-dispose on mouseup
		const moveDisposable = dom.addDisposableListener(win, 'mousemove', mv => this._onDragMove(mv));
		const upDisposable = dom.addDisposableListener(win, 'mouseup', () => {
			this._dragState = null;
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
	}

	// -------------------------------------------------------------------------
	// Resize
	// -------------------------------------------------------------------------

	/** Show resize handles when the pointer is near the bubble border. */
	private _bindBorderHover(): void {
		this._disposables.add(dom.addDisposableListener(this._element, 'mousemove', e => {
			const rect = this._element.getBoundingClientRect();
			const edgeThreshold = 10;
			const nearEdge =
				e.clientX - rect.left < edgeThreshold ||
				rect.right - e.clientX < edgeThreshold ||
				e.clientY - rect.top < edgeThreshold ||
				rect.bottom - e.clientY < edgeThreshold;
			this._setHandlesVisible(nearEdge);
		}));
		this._disposables.add(dom.addDisposableListener(this._element, 'mouseleave', () => {
			this._setHandlesVisible(false);
		}));
	}

	private _setHandlesVisible(visible: boolean): void {
		for (const handle of this._resizeHandleElements) {
			handle.style.opacity = visible ? '1' : '0';
		}
	}

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
