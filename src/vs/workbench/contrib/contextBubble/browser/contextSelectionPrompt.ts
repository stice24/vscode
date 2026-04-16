/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';

// ---------------------------------------------------------------------------
// Style injection — runs once per page lifetime
// ---------------------------------------------------------------------------

let _promptStylesInjected = false;

function ensurePromptStyles(): void {
	if (_promptStylesInjected) {
		return;
	}
	_promptStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `
.cb-selection-prompt {
	position: absolute;
	z-index: 51;
	display: flex;
	align-items: center;
	gap: 4px;
	background: #111318;
	border: 1px solid rgba(80, 200, 220, 0.22);
	border-radius: 6px;
	padding: 5px 8px;
	box-shadow:
		0 2px 8px rgba(0, 0, 0, 0.55),
		0 0 0 1px rgba(80, 200, 220, 0.08);
	font-family: system-ui, -apple-system, sans-serif;
	font-size: 11px;
	pointer-events: all;
	user-select: none;
	white-space: nowrap;
	animation: cb-prompt-fadein 0.12s ease;
}
@keyframes cb-prompt-fadein {
	from { opacity: 0; transform: translateY(-3px); }
	to   { opacity: 1; transform: translateY(0); }
}
.cb-selection-prompt-label {
	color: rgba(180, 190, 200, 0.50);
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-right: 2px;
}
.cb-selection-prompt-symbol {
	background: none;
	border: 1px solid rgba(80, 200, 220, 0.30);
	border-radius: 4px;
	color: rgba(80, 200, 220, 0.95);
	cursor: pointer;
	font-family: monospace;
	font-size: 11px;
	line-height: 1;
	padding: 2px 7px;
	transition: background 0.1s, border-color 0.1s;
}
.cb-selection-prompt-symbol:hover {
	background: rgba(80, 200, 220, 0.10);
	border-color: rgba(80, 200, 220, 0.55);
}
.cb-selection-prompt-dismiss {
	background: none;
	border: none;
	color: rgba(180, 190, 200, 0.40);
	cursor: pointer;
	font-size: 13px;
	line-height: 1;
	padding: 1px 3px;
	border-radius: 3px;
	margin-left: 2px;
	transition: color 0.1s, background 0.1s;
}
.cb-selection-prompt-dismiss:hover {
	color: rgba(210, 220, 230, 0.85);
	background: rgba(255, 255, 255, 0.08);
}
`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Ephemeral floating prompt shown when the user triggers the context bubble on a
 * partial selection inside a named function or class.
 *
 * Offers two actions:
 * - Click the symbol name → `onDidSelectSymbol` fires; caller expands the
 *   editor selection and re-triggers the bubble.
 * - Click "×" / press Escape / click anywhere outside / wait 4 s →
 *   `onDidDismiss` fires; no bubble is opened.
 *
 * The element is removed from the DOM when `dispose()` is called.
 * All internal listeners are cleaned up — there are no leaks.
 */
export class PartialSelectionPrompt extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _disposables = this._register(new DisposableStore());

	private readonly _onDidSelectSymbol = this._register(new Emitter<void>());
	private readonly _onDidDismiss = this._register(new Emitter<void>());

	/** Fires when the user clicks the symbol name button. */
	readonly onDidSelectSymbol: Event<void> = this._onDidSelectSymbol.event;

	/** Fires when the prompt is dismissed without selecting a symbol. */
	readonly onDidDismiss: Event<void> = this._onDidDismiss.event;

	constructor(
		container: HTMLElement,
		x: number,
		y: number,
		symbolName: string,
	) {
		super();
		ensurePromptStyles();

		this._element = this._buildElement(x, y, symbolName);
		container.appendChild(this._element);

		// Auto-dismiss after 4 seconds with no interaction
		const timer = setTimeout(() => this._dismiss(), 4000);
		this._register({ dispose: () => clearTimeout(timer) });

		// Dismiss on Escape (capture phase so it runs before the editor)
		this._disposables.add(dom.addDisposableListener(mainWindow.document, 'keydown', e => {
			if (e.key === 'Escape') {
				this._dismiss();
			}
		}, true /* capture */));

		// Dismiss when the user clicks anywhere outside the prompt
		this._disposables.add(dom.addDisposableListener(mainWindow.document, 'mousedown', e => {
			if (!this._element.contains(e.target as Node)) {
				this._dismiss();
			}
		}, true /* capture */));
	}

	// -------------------------------------------------------------------------
	// DOM construction
	// -------------------------------------------------------------------------

	private _buildElement(x: number, y: number, symbolName: string): HTMLElement {
		const root = document.createElement('div');
		root.className = 'cb-selection-prompt';
		root.style.left = `${x}px`;
		root.style.top = `${y}px`;

		const label = document.createElement('span');
		label.className = 'cb-selection-prompt-label';
		label.textContent = 'Expand to';

		const symbolBtn = document.createElement('button');
		symbolBtn.className = 'cb-selection-prompt-symbol';
		symbolBtn.textContent = symbolName;
		this._disposables.add(dom.addDisposableListener(symbolBtn, 'click', e => {
			e.stopPropagation();
			this._onDidSelectSymbol.fire();
			this.dispose();
		}));

		const dismissBtn = document.createElement('button');
		dismissBtn.className = 'cb-selection-prompt-dismiss';
		dismissBtn.textContent = '\u00d7';
		this._disposables.add(dom.addDisposableListener(dismissBtn, 'click', e => {
			e.stopPropagation();
			this._dismiss();
		}));

		root.appendChild(label);
		root.appendChild(symbolBtn);
		root.appendChild(dismissBtn);

		return root;
	}

	private _dismiss(): void {
		this._onDidDismiss.fire();
		this.dispose();
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		this._element.remove();
		super.dispose();
	}
}
