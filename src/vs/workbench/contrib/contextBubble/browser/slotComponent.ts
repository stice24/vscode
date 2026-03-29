/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';

export type SlotState = 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Base styles — injected once per page lifetime
// ---------------------------------------------------------------------------

let _slotBaseStylesInjected = false;

function ensureSlotBaseStyles(): void {
	if (_slotBaseStylesInjected) {
		return;
	}
	_slotBaseStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `

@keyframes ctx-skeleton-pulse {
	0%, 100% { opacity: 0.22; }
	50%       { opacity: 0.48; }
}

.slot-skeleton {
	padding: 10px 14px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.slot-skeleton-bar {
	height: 7px;
	border-radius: 4px;
	background: rgba(120, 140, 160, 0.4);
	animation: ctx-skeleton-pulse 1.6s ease-in-out infinite;
}

.slot-skeleton-bar:nth-child(1) { width: 68%; }
.slot-skeleton-bar:nth-child(2) { width: 84%; animation-delay: 0.18s; }
.slot-skeleton-bar:nth-child(3) { width: 52%; animation-delay: 0.36s; }

.slot-error-msg {
	padding: 8px 14px;
	font-size: 10px;
	color: rgba(205, 115, 95, 0.85);
	font-family: system-ui, -apple-system, sans-serif;
}

`;
	mainWindow.document.head.appendChild(style);
}

/**
 * Abstract base class for context bubble slot components.
 * Each slot independently tracks its own loading / success / error state.
 * A slow or failed slot does not block sibling slots.
 */
export abstract class SlotComponent extends Disposable {

	protected readonly element: HTMLElement;
	private _state: SlotState = 'loading';
	private _placeholderEl: HTMLElement | null = null;

	constructor(container: HTMLElement, label: string) {
		super();
		ensureSlotBaseStyles();

		this.element = document.createElement('div');
		this.element.className = 'context-bubble-slot';
		this.element.style.cssText = [
			'flex: 1',
			'overflow: hidden',
			'position: relative',
			'min-height: 0',
			'display: flex',
			'flex-direction: column',
		].join('; ');

		if (label) {
			const labelEl = document.createElement('div');
			labelEl.className = 'slot-label';
			labelEl.textContent = label;
			this.element.appendChild(labelEl);
		}

		container.appendChild(this.element);
		this._applyState();
	}

	get state(): SlotState {
		return this._state;
	}

	/**
	 * Transition this slot to a new state.
	 * Clears the previous state's UI before rendering the new one.
	 */
	setState(state: SlotState): void {
		if (this._state === state) {
			return;
		}
		this._state = state;
		this._applyState();
	}

	private _applyState(): void {
		this.element.dataset['state'] = this._state;

		if (this._placeholderEl) {
			this._placeholderEl.remove();
			this._placeholderEl = null;
		}

		if (this._state === 'loading') {
			this._renderLoadingSkeleton();
		} else if (this._state === 'error') {
			this._renderErrorMessage();
		}
	}

	private _renderLoadingSkeleton(): void {
		const skeleton = document.createElement('div');
		skeleton.className = 'slot-skeleton';
		for (let i = 0; i < 3; i++) {
			const bar = document.createElement('div');
			bar.className = 'slot-skeleton-bar';
			skeleton.appendChild(bar);
		}
		this._placeholderEl = skeleton;
		this.element.appendChild(skeleton);
	}

	private _renderErrorMessage(): void {
		const el = document.createElement('div');
		el.className = 'slot-error-msg';
		el.textContent = 'Failed to load';
		this._placeholderEl = el;
		this.element.appendChild(el);
	}

	/**
	 * Called when data for this slot arrives.
	 * Implementations must call `setState('success')` then render content
	 * into `this.element`.
	 */
	abstract renderContent(data: unknown): void;

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}
