/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SlotComponent } from './slotComponent.js';
import { mainWindow } from '../../../../base/browser/window.js';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

let _gitHistoryStylesInjected = false;

function ensureGitHistoryStyles(): void {
	if (_gitHistoryStylesInjected) {
		return;
	}
	_gitHistoryStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `

.git-commit-list {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	flex: 1;
	min-height: 0;
	padding-bottom: 6px;
}

.git-commit-entry {
	padding: 6px 14px 6px 10px;
	border-left: 2px solid rgba(80, 200, 220, 0.28);
	margin: 2px 8px 2px 8px;
	border-radius: 0 3px 3px 0;
	cursor: default;
	transition: background 0.1s;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.git-commit-entry:hover {
	background: rgba(80, 200, 220, 0.05);
	border-left-color: rgba(80, 200, 220, 0.48);
}

.git-commit-meta {
	display: flex;
	align-items: center;
	gap: 7px;
}

.git-commit-hash {
	font-family: monospace, "Courier New";
	font-size: 9.5px;
	color: rgba(130, 155, 172, 0.72);
	letter-spacing: 0.02em;
	flex-shrink: 0;
}

.git-commit-author {
	font-size: 10px;
	color: rgba(160, 175, 188, 0.75);
	font-family: system-ui, -apple-system, sans-serif;
	flex-shrink: 0;
}

.git-commit-time {
	font-size: 9px;
	color: rgba(130, 148, 160, 0.5);
	font-family: system-ui, -apple-system, sans-serif;
	margin-left: auto;
}

.git-commit-message {
	font-size: 10.5px;
	color: rgba(192, 204, 215, 0.85);
	font-family: system-ui, -apple-system, sans-serif;
	line-height: 1.4;
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: 4px;
}

.git-pr-tag {
	display: inline-block;
	font-size: 9px;
	font-family: monospace, "Courier New";
	color: rgba(78, 201, 176, 0.88);
	background: rgba(78, 201, 176, 0.1);
	border: 1px solid rgba(78, 201, 176, 0.22);
	border-radius: 3px;
	padding: 0 4px;
	flex-shrink: 0;
}

`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single commit entry as shown in the git history slot. */
export interface CommitEntry {
	/** Short (7-char) commit hash. */
	hash: string;
	/** Commit author display name. */
	author: string;
	/** Human-readable relative time string, e.g. "2h ago". */
	relativeTime: string;
	/** Full commit message. May include a PR reference like "(#142)". */
	message: string;
}

// ---------------------------------------------------------------------------
// Mock data — replace with git service results when wiring real data
// ---------------------------------------------------------------------------

export const MOCK_COMMITS: CommitEntry[] = [
	{ hash: 'a3f8c12', author: 'alice', relativeTime: '2h ago', message: 'Fix null dereference in error recovery path' },
	{ hash: '7b2e91d', author: 'bob', relativeTime: '1d ago', message: 'Refactor for readability and perf (#142)' },
	{ hash: 'c5a0f34', author: 'carol', relativeTime: '3d ago', message: 'Add coverage for unterminated input edge cases' },
	{ hash: '92dd17a', author: 'alice', relativeTime: '8d ago', message: 'Initial implementation' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Splits a commit message into body text and an optional PR reference tag. */
function parseMessage(msg: string): { body: string; pr: string | undefined } {
	const m = msg.match(/\(#(\d+)\)/);
	if (!m) {
		return { body: msg, pr: undefined };
	}
	return { body: msg.replace(m[0], '').trim(), pr: '#' + m[1] };
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

/**
 * Slot 2 — Git / PR History.
 *
 * Renders a commit list scoped to the highlighted symbol's line range.
 * Each entry shows: short hash, author, relative timestamp, and message.
 * Commit messages that reference a PR number render a distinct tag.
 */
export class GitHistorySlot extends SlotComponent {

	constructor(container: HTMLElement) {
		super(container, 'Git History');
		ensureGitHistoryStyles();
	}

	override renderContent(data: unknown): void {
		const commits = data as CommitEntry[];
		this.setState('success');
		this._renderList(commits);
	}

	private _renderList(commits: CommitEntry[]): void {
		const list = document.createElement('div');
		list.className = 'git-commit-list';

		for (const commit of commits) {
			list.appendChild(this._buildEntry(commit));
		}

		this.element.appendChild(list);
	}

	private _buildEntry(commit: CommitEntry): HTMLElement {
		const entry = document.createElement('div');
		entry.className = 'git-commit-entry';

		// Row 1 — hash · author · time
		const meta = document.createElement('div');
		meta.className = 'git-commit-meta';

		const hash = document.createElement('span');
		hash.className = 'git-commit-hash';
		hash.textContent = commit.hash;

		const author = document.createElement('span');
		author.className = 'git-commit-author';
		author.textContent = commit.author;

		const time = document.createElement('span');
		time.className = 'git-commit-time';
		time.textContent = commit.relativeTime;

		meta.appendChild(hash);
		meta.appendChild(author);
		meta.appendChild(time);

		// Row 2 — message (+ optional PR tag)
		const msgRow = document.createElement('div');
		msgRow.className = 'git-commit-message';

		const { body, pr } = parseMessage(commit.message);

		const bodySpan = document.createElement('span');
		bodySpan.textContent = body;
		msgRow.appendChild(bodySpan);

		if (pr) {
			const tag = document.createElement('span');
			tag.className = 'git-pr-tag';
			tag.textContent = pr;
			msgRow.appendChild(tag);
		}

		entry.appendChild(meta);
		entry.appendChild(msgRow);

		return entry;
	}
}
