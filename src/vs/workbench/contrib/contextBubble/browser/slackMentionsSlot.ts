/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SlotComponent } from './slotComponent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import * as nls from '../../../../nls.js';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

let _slackStylesInjected = false;

function ensureSlackStyles(): void {
	if (_slackStylesInjected) {
		return;
	}
	_slackStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `

.slack-slot-header {
	display: flex;
	align-items: center;
	padding: 0 14px;
	min-height: 22px;
	flex-shrink: 0;
}

.slack-slot-label {
	text-transform: uppercase;
	letter-spacing: 0.07em;
	font-size: 9px;
	color: rgba(130, 148, 160, 0.55);
	font-family: system-ui, -apple-system, sans-serif;
	font-weight: 500;
}

.slack-slot-controls {
	display: flex;
	align-items: center;
	gap: 5px;
	margin-left: auto;
}

.slack-disconnect-btn {
	font-size: 9px;
	color: rgba(130, 148, 160, 0.45);
	font-family: system-ui, -apple-system, sans-serif;
	cursor: pointer;
	padding: 1px 4px;
	border-radius: 3px;
	transition: color 0.1s, background 0.1s;
	border: none;
	background: none;
}

.slack-disconnect-btn:hover {
	color: rgba(180, 80, 80, 0.85);
	background: rgba(180, 80, 80, 0.08);
}

.slack-channel-tag {
	display: inline-flex;
	align-items: center;
	gap: 3px;
	font-size: 9px;
	font-family: monospace, "Courier New";
	color: rgba(78, 201, 176, 0.88);
	background: rgba(78, 201, 176, 0.1);
	border: 1px solid rgba(78, 201, 176, 0.22);
	border-radius: 3px;
	padding: 1px 5px 1px 5px;
	cursor: pointer;
	transition: background 0.1s, border-color 0.1s;
}

.slack-channel-tag:hover {
	background: rgba(78, 201, 176, 0.16);
	border-color: rgba(78, 201, 176, 0.36);
}

.slack-channel-tag-clear {
	color: rgba(78, 201, 176, 0.55);
	font-size: 9px;
	cursor: pointer;
	line-height: 1;
	margin-left: 1px;
}

.slack-channel-tag-clear:hover {
	color: rgba(78, 201, 176, 0.9);
}

.slack-search-icon {
	font-size: 9px;
	color: rgba(130, 148, 160, 0.45);
	cursor: pointer;
	padding: 1px 4px;
	border-radius: 3px;
	transition: color 0.1s, background 0.1s;
}

.slack-search-icon:hover {
	color: rgba(78, 201, 176, 0.75);
	background: rgba(78, 201, 176, 0.07);
}

.slack-message-list {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	flex: 1;
	min-height: 0;
	padding-bottom: 6px;
}

.slack-message-entry {
	padding: 5px 14px 5px 14px;
	cursor: pointer;
	transition: background 0.1s;
}

.slack-message-entry:hover {
	background: rgba(80, 200, 220, 0.04);
}

.slack-message-header {
	display: flex;
	align-items: baseline;
	gap: 0;
	margin-bottom: 2px;
}

.slack-username {
	font-family: monospace, "Courier New";
	font-size: 10px;
	font-weight: 500;
	color: rgba(78, 201, 176, 0.88);
	flex-shrink: 0;
}

.slack-username::after {
	content: '';
	display: inline-block;
	width: 6px;
}

.slack-timestamp {
	font-size: 9px;
	color: rgba(130, 148, 160, 0.5);
	font-family: system-ui, -apple-system, sans-serif;
	margin-left: auto;
}

.slack-channel-badge {
	display: inline-block;
	font-size: 9px;
	font-family: monospace, "Courier New";
	color: rgba(78, 201, 176, 0.7);
	background: rgba(78, 201, 176, 0.08);
	border: 1px solid rgba(78, 201, 176, 0.18);
	border-radius: 3px;
	padding: 0 4px;
	margin-left: 6px;
	flex-shrink: 0;
}

.slack-message-body {
	font-size: 10.5px;
	color: rgba(188, 200, 212, 0.82);
	font-family: system-ui, -apple-system, sans-serif;
	line-height: 1.45;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.slack-no-results {
	padding: 10px 14px;
	font-size: 10px;
	color: rgba(130, 148, 160, 0.4);
	font-family: system-ui, -apple-system, sans-serif;
	font-style: italic;
}

.slack-not-configured {
	padding: 10px 14px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.slack-connect-btn {
	display: inline-block;
	font-size: 10px;
	font-family: system-ui, -apple-system, sans-serif;
	color: rgba(78, 201, 176, 0.85);
	background: rgba(78, 201, 176, 0.1);
	border: 1px solid rgba(78, 201, 176, 0.25);
	border-radius: 4px;
	padding: 3px 9px;
	cursor: pointer;
	transition: background 0.1s, border-color 0.1s, color 0.1s;
	width: fit-content;
}

.slack-connect-btn:hover {
	background: rgba(78, 201, 176, 0.18);
	border-color: rgba(78, 201, 176, 0.42);
	color: rgba(78, 201, 176, 1);
}

`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Slack message as shown in the mentions slot. */
export interface SlackMessage {
	/** Slack username without the @ sigil. */
	username: string;
	/** Message body text. */
	content: string;
	/** Human-readable relative time, e.g. "10m ago". */
	relativeTime: string;
	/**
	 * Channel name — populated only in whole-workspace mode so the user can see
	 * where the message came from. Omitted when a channel filter is active.
	 */
	channelName?: string;
	/** Slack permalink for deep-link navigation (slack:// scheme on desktop). */
	permalink: string;
}

/** Callbacks wired by the controller for user-initiated actions in the slot. */
export interface ISlackMentionsSlotCallbacks {
	/** User clicked "Connect Slack" in the not-configured state. */
	onConnectClicked(): void;
	/** User clicked "Disconnect" in the slot header. */
	onDisconnectClicked(): void;
	/** User clicked the channel search icon or active channel tag to pick a channel. */
	onChannelTagClicked(): void;
	/** User clicked the × on an active channel tag to return to whole-workspace mode. */
	onChannelClearClicked(): void;
	/** User clicked a result card — navigate to the Slack message. */
	onMessageClicked(permalink: string): void;
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

/**
 * Slot 3 — Slack Mentions.
 *
 * Renders a compact thread of Slack messages that mention the highlighted
 * symbol. Supports four visual states:
 *
 * - **Not configured** — "Connect Slack" button.
 * - **Loading** — skeleton pulse (base class).
 * - **Results** — clickable message cards, newest first.
 * - **No results** — quiet "No mentions found" message.
 * - **Error** — base class error treatment.
 *
 * Header controls (visible only when connected):
 * - Channel search icon (whole-workspace mode) or active channel tag with ×.
 * - "Disconnect" affordance.
 *
 * All auth and API logic lives in the controller; the slot only renders.
 *
 * Token generation (for reference only — no UI is built for this):
 *   1. Create a Slack app at api.slack.com/apps.
 *   2. Add scopes: search:read, channels:read.
 *   3. Copy the user token (xoxp-...).
 */
export class SlackMentionsSlot extends SlotComponent {

	private readonly _callbacks: ISlackMentionsSlotCallbacks;
	private readonly _headerEl: HTMLElement;
	private readonly _controlsEl: HTMLElement;
	/** Currently rendered content subtree (not-configured view, message list, no-results). */
	private _ownedContent: HTMLElement | null = null;

	constructor(container: HTMLElement, callbacks: ISlackMentionsSlotCallbacks) {
		// Pass empty label — we build our own header below for full layout control.
		super(container, '');
		this._callbacks = callbacks;
		ensureSlackStyles();

		// Build the header row and insert it before the loading skeleton that the
		// base constructor already appended.
		const { header, controls } = this._buildHeader();
		this._headerEl = header;
		this._controlsEl = controls;
		this.element.insertBefore(this._headerEl, this.element.firstChild);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Renders the "not configured" state with a single "Connect Slack" button.
	 * Call when no token is stored.
	 */
	renderNotConfigured(): void {
		this.setState('success');
		this._clearOwnedContent();

		const wrapper = document.createElement('div');
		wrapper.className = 'slack-not-configured';

		const btn = document.createElement('button');
		btn.className = 'slack-connect-btn';
		btn.textContent = nls.localize('slack.connectButton', 'Connect Slack');
		btn.addEventListener('click', () => this._callbacks.onConnectClicked());

		wrapper.appendChild(btn);
		this._ownedContent = wrapper;
		this.element.appendChild(wrapper);
	}

	/**
	 * Updates the slot header to reflect connection state.
	 *
	 * @param connected `true` once a token is stored.
	 * @param channel   Active channel name filter, or `undefined` for whole-workspace.
	 */
	setConnectedState(connected: boolean, channel?: string): void {
		// Rebuild controls area from scratch on each state change.
		while (this._controlsEl.lastChild) {
			this._controlsEl.removeChild(this._controlsEl.lastChild);
		}

		if (!connected) {
			return;
		}

		if (channel) {
			// Active channel tag: clicking the tag body re-opens the picker; × clears.
			const tag = document.createElement('span');
			tag.className = 'slack-channel-tag';
			tag.title = nls.localize('slack.channel.clickToChange', 'Click to change channel');

			const tagLabel = document.createElement('span');
			tagLabel.textContent = `#${channel}`;
			tagLabel.addEventListener('click', () => this._callbacks.onChannelTagClicked());

			const clearBtn = document.createElement('span');
			clearBtn.className = 'slack-channel-tag-clear';
			clearBtn.textContent = '×';
			clearBtn.title = nls.localize('slack.channel.clear', 'Clear channel filter');
			clearBtn.addEventListener('click', e => {
				e.stopPropagation();
				this._callbacks.onChannelClearClicked();
			});

			tag.appendChild(tagLabel);
			tag.appendChild(clearBtn);
			this._controlsEl.appendChild(tag);
		} else {
			// No channel — search icon opens the picker.
			const searchIcon = document.createElement('span');
			searchIcon.className = 'slack-search-icon';
			searchIcon.textContent = '⋯';
			searchIcon.title = nls.localize('slack.channel.filter', 'Filter by channel');
			searchIcon.addEventListener('click', () => this._callbacks.onChannelTagClicked());
			this._controlsEl.appendChild(searchIcon);
		}

		const disconnectBtn = document.createElement('button');
		disconnectBtn.className = 'slack-disconnect-btn';
		disconnectBtn.textContent = nls.localize('slack.disconnectButton', 'Disconnect');
		disconnectBtn.addEventListener('click', () => this._callbacks.onDisconnectClicked());
		this._controlsEl.appendChild(disconnectBtn);
	}

	/**
	 * Renders result cards. An empty array produces the "No mentions found" view.
	 * Always call `setConnectedState(true, ...)` before this so header controls
	 * are in sync.
	 */
	private _lastRenderedMessages: SlackMessage[] | null = null;

	override renderContent(data: unknown): void {
		const messages = data as SlackMessage[];
		this._lastRenderedMessages = messages;
		this.setState('success');
		this._clearOwnedContent();

		if (messages.length === 0) {
			this._renderNoResults();
			return;
		}

		this._renderCards(messages);
	}

	override getContextSummary(): string {
		const messages = this._lastRenderedMessages;
		if (!messages || messages.length === 0) {
			return '';
		}
		const lines = messages.map(m => {
			const channel = m.channelName ? ` in #${m.channelName}` : '';
			return `- @${m.username}${channel} (${m.relativeTime}): ${m.content}`;
		});
		return `**Slack Mentions**\n${lines.join('\n')}`;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private _buildHeader(): { header: HTMLElement; controls: HTMLElement } {
		const header = document.createElement('div');
		header.className = 'slack-slot-header';

		const label = document.createElement('span');
		label.className = 'slack-slot-label slot-label';
		label.textContent = nls.localize('slack.slotLabel', 'Slack Mentions');

		const controls = document.createElement('span');
		controls.className = 'slack-slot-controls';

		header.appendChild(label);
		header.appendChild(controls);
		return { header, controls };
	}

	private _clearOwnedContent(): void {
		if (this._ownedContent) {
			this._ownedContent.remove();
			this._ownedContent = null;
		}
	}

	private _renderNoResults(): void {
		const el = document.createElement('div');
		el.className = 'slack-no-results';
		el.textContent = nls.localize('slack.noResults', 'No mentions found');
		this._ownedContent = el;
		this.element.appendChild(el);
	}

	private _renderCards(messages: SlackMessage[]): void {
		const list = document.createElement('div');
		list.className = 'slack-message-list';

		for (const msg of messages) {
			list.appendChild(this._buildCard(msg));
		}

		this._ownedContent = list;
		this.element.appendChild(list);
	}

	private _buildCard(msg: SlackMessage): HTMLElement {
		const entry = document.createElement('div');
		entry.className = 'slack-message-entry';

		if (msg.permalink) {
			entry.addEventListener('click', () => this._callbacks.onMessageClicked(msg.permalink));
		}

		// Row 1 — username · optional channel badge · timestamp
		const header = document.createElement('div');
		header.className = 'slack-message-header';

		const username = document.createElement('span');
		username.className = 'slack-username';
		username.textContent = msg.username;

		if (msg.channelName) {
			const badge = document.createElement('span');
			badge.className = 'slack-channel-badge';
			badge.textContent = `#${msg.channelName}`;
			header.appendChild(username);
			header.appendChild(badge);
		} else {
			header.appendChild(username);
		}

		const time = document.createElement('span');
		time.className = 'slack-timestamp';
		time.textContent = msg.relativeTime;
		header.appendChild(time);

		// Row 2 — message preview
		const body = document.createElement('div');
		body.className = 'slack-message-body';
		body.textContent = msg.content;

		entry.appendChild(header);
		entry.appendChild(body);
		return entry;
	}
}
