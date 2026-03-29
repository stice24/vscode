/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SlotComponent } from './slotComponent.js';
import { mainWindow } from '../../../../base/browser/window.js';

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
	cursor: default;
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

.slack-message-body {
	font-size: 10.5px;
	color: rgba(188, 200, 212, 0.82);
	font-family: system-ui, -apple-system, sans-serif;
	line-height: 1.45;
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
}

// ---------------------------------------------------------------------------
// Mock data — replace with Slack Search API results when wiring real data
// ---------------------------------------------------------------------------

/**
 * Returns a set of mock Slack messages that naturally reference `symbolName`.
 * Newest message first, mirroring Slack search result ordering.
 */
export function buildMockSlackMessages(symbolName: string): SlackMessage[] {
	return [
		{
			username: 'carol',
			content: `heads up: ${symbolName} is being deprecated in the next major — see RFC-44 for the migration path`,
			relativeTime: '5m ago',
		},
		{
			username: 'bob',
			content: `yeah I traced the leak back to ${symbolName} — PR up for review, would appreciate a second look`,
			relativeTime: '1h ago',
		},
		{
			username: 'alice',
			content: `has anyone looked at ${symbolName} recently? seeing strange behaviour in the staging environment`,
			relativeTime: '2h ago',
		},
	];
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

/**
 * Slot 3 — Slack Mentions.
 *
 * Renders a compact message thread of Slack messages that mention the
 * highlighted symbol. Newest message appears first.
 * Auth and live Slack API calls are wired in a later session — mock data only.
 */
export class SlackMentionsSlot extends SlotComponent {

	constructor(container: HTMLElement) {
		super(container, 'Slack Mentions');
		ensureSlackStyles();
	}

	override renderContent(data: unknown): void {
		const messages = data as SlackMessage[];
		this.setState('success');
		this._renderThread(messages);
	}

	private _renderThread(messages: SlackMessage[]): void {
		const list = document.createElement('div');
		list.className = 'slack-message-list';

		for (const msg of messages) {
			list.appendChild(this._buildEntry(msg));
		}

		this.element.appendChild(list);
	}

	private _buildEntry(msg: SlackMessage): HTMLElement {
		const entry = document.createElement('div');
		entry.className = 'slack-message-entry';

		const header = document.createElement('div');
		header.className = 'slack-message-header';

		const username = document.createElement('span');
		username.className = 'slack-username';
		username.textContent = msg.username;

		const time = document.createElement('span');
		time.className = 'slack-timestamp';
		time.textContent = msg.relativeTime;

		header.appendChild(username);
		header.appendChild(time);

		const body = document.createElement('div');
		body.className = 'slack-message-body';
		body.textContent = msg.content;

		entry.appendChild(header);
		entry.appendChild(body);

		return entry;
	}
}
