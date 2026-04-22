/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';

export type SlotState = 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Slot configuration types — shared by widget, overlay, and controller
// ---------------------------------------------------------------------------

/** Stable identifier for a data source assignable to a slot position. */
export type SlotSourceId =
	| 'contextBubble.callGraph'
	| 'contextBubble.gitHistory'
	| 'contextBubble.slackMentions';

/** Stable key for a named slot position within the bubble. */
export type SlotPositionKey = 'slot.top' | 'slot.middle' | 'slot.bottom';

/** Layout preset controlling how the three positions are arranged visually. */
export type LayoutPresetId =
	| 'vertical3'    // 3 equal slots stacked vertically (default)
	| 'largeBottom'  // 2 small top, 1 large bottom
	| 'largeTop'     // 1 large top, 2 small bottom
	| 'horizontal3'  // 3 equal slots side by side
	| 'fullBleed';   // single slot fills the entire bubble

/** Full slot configuration stored in workbench.configuration. */
export interface ISlotConfig {
	preset: LayoutPresetId;
	assignments: Partial<Record<SlotPositionKey, SlotSourceId>>;
}

/** Ordered list of all position keys. */
export const SLOT_POSITION_KEYS: SlotPositionKey[] = ['slot.top', 'slot.middle', 'slot.bottom'];

/** All registered source IDs. */
export const ALL_SOURCE_IDS: SlotSourceId[] = [
	'contextBubble.callGraph',
	'contextBubble.gitHistory',
	'contextBubble.slackMentions',
];

/** Human-readable display labels for each source. */
export const SOURCE_LABELS: Record<SlotSourceId, string> = {
	'contextBubble.callGraph': 'Call Graph',
	'contextBubble.gitHistory': 'Git History',
	'contextBubble.slackMentions': 'Slack Mentions',
};

/** Default configuration: 3 stacked vertically, one source per slot. */
export const DEFAULT_SLOT_CONFIG: ISlotConfig = {
	preset: 'vertical3',
	assignments: {
		'slot.top': 'contextBubble.callGraph',
		'slot.middle': 'contextBubble.gitHistory',
		'slot.bottom': 'contextBubble.slackMentions',
	},
};

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

	/** Public accessor for the slot's root DOM element — needed for layout re-ordering. */
	get domElement(): HTMLElement {
		return this.element;
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

	/** Returns a markdown summary of the slot's current data for sending to Copilot. */
	getContextSummary(): string {
		return '';
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}
