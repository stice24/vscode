/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';

export type SlotState = 'loading' | 'success' | 'error';

/**
 * Abstract base class for context bubble slot components.
 * Each slot independently tracks its own loading / success / error state.
 * A slow or failed slot does not block sibling slots.
 */
export abstract class SlotComponent extends Disposable {

	protected readonly element: HTMLElement;
	private _state: SlotState = 'loading';
	private _placeholderEl: HTMLElement | null = null;

	constructor(container: HTMLElement) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'context-bubble-slot';
		this.element.style.cssText = [
			'flex: 1',
			'overflow: hidden',
			'position: relative',
			'min-height: 0',
		].join('; ');
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

		// Clear previous placeholder content but leave any subclass-rendered content intact
		if (this._placeholderEl) {
			this._placeholderEl.remove();
			this._placeholderEl = null;
		}

		if (this._state === 'loading') {
			this._renderPlaceholder('Loading\u2026');
		} else if (this._state === 'error') {
			this._renderPlaceholder('Failed to load');
		}
	}

	private _renderPlaceholder(text: string): void {
		const el = document.createElement('div');
		el.className = 'slot-placeholder';
		el.textContent = text;
		el.style.cssText = [
			'padding: 8px 10px',
			'font-size: 11px',
			'opacity: 0.5',
			'color: var(--vscode-foreground, #ccc)',
		].join('; ');
		this._placeholderEl = el;
		this.element.appendChild(el);
	}

	/**
	 * Called when data for this slot arrives.
	 * Implementations should call `setState("success")` and render their content.
	 */
	abstract renderContent(data: unknown): void;

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}
