/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextBubbleWidget } from './contextBubbleWidget.js';
import { ContextBubbleAnchor } from './contextBubbleAnchor.js';
import { ContextBubbleArrow } from './contextBubbleArrow.js';
import { CallGraphSlot, MOCK_CALL_GRAPH_CALLERS, MOCK_CALL_GRAPH_CALLEES } from './callGraphSlot.js';
import { GitHistorySlot, MOCK_COMMITS } from './gitHistorySlot.js';
import { SlackMentionsSlot, buildMockSlackMessages } from './slackMentionsSlot.js';

export const CONTEXT_BUBBLE_COMMAND_ID = 'contextBubble.trigger';

/** Default bubble dimensions — kept in sync with constants in contextBubbleWidget.ts. */
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 460;

/**
 * Workbench contribution that owns the full context bubble lifecycle.
 *
 * **Interaction flow**
 * 1. Hotkey → places the gutter anchor "+" at the trigger line. Bubble is NOT shown yet.
 * 2. User clicks "+" → bubble opens in open space, bezier arrow appears.
 * 3. "minus" button → bubble hidden, anchor stays so user can click "+" to restore.
 * 4. "×" button → everything torn down (bubble + anchor + arrow).
 * 5. Hotkey while bubble is hidden → re-expands the hidden bubble.
 */
export class ContextBubbleController extends Disposable {

	static readonly ID = 'workbench.contrib.contextBubble';

	private readonly _bubbleSlot = this._register(new MutableDisposable<ContextBubbleWidget>());
	private readonly _anchorSlot = this._register(new MutableDisposable<ContextBubbleAnchor>());
	private readonly _arrowSlot = this._register(new MutableDisposable<ContextBubbleArrow>());

	/**
	 * Subscriptions scoped to the current session (anchor + bubble + arrow + slots).
	 * Cleared entirely on teardown so nothing outlives the session.
	 */
	private readonly _sessionDisposables = this._register(new DisposableStore());

	/**
	 * The editor that owns the current anchor.
	 * Stored so scroll events can be wired without re-capturing the editor context.
	 */
	private _anchoredEditor: ICodeEditor | undefined;

	/**
	 * Symbol name captured at trigger time — used as the centre node in the
	 * call graph and as the search term for Slack mentions.
	 */
	private _currentSymbolName = '';

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(CONTEXT_BUBBLE_COMMAND_ID, () => {
			this._triggerBubble();
		}));
	}

	// -------------------------------------------------------------------------
	// Hotkey handler — anchor only
	// -------------------------------------------------------------------------

	private _triggerBubble(): void {
		const existingBubble = this._bubbleSlot.value;

		// Hotkey while bubble is hidden → re-expand it (same as clicking "+")
		if (existingBubble && !existingBubble.isVisible) {
			this._openBubble();
			return;
		}

		// Bubble already visible, or anchor already placed — nothing to do
		if (existingBubble?.isVisible || this._anchorSlot.value) {
			return;
		}

		// First press: place the anchor, do not open the bubble yet
		const editorContext = this._resolveEditorContext();
		if (!editorContext) {
			return;
		}

		this._currentSymbolName = editorContext.symbolName;

		const anchor = new ContextBubbleAnchor(editorContext.editor, editorContext.lineNumber);
		this._anchorSlot.value = anchor;
		this._anchoredEditor = editorContext.editor;

		// Anchor click always opens (or re-opens) the bubble
		this._sessionDisposables.add(anchor.onDidClick(() => this._openBubble()));

		// Keep arrow in sync when the anchor scrolls with the code
		this._sessionDisposables.add(
			editorContext.editor.onDidScrollChange(() => this._updateArrow())
		);
	}

	// -------------------------------------------------------------------------
	// Bubble open — called from anchor click and hotkey re-expand
	// -------------------------------------------------------------------------

	private _openBubble(): void {
		const container = this._layoutService.getContainer(mainWindow);

		// Always create a fresh arrow — the previous one may have already faded
		const arrow = new ContextBubbleArrow(container);
		this._arrowSlot.value = arrow;

		const existingBubble = this._bubbleSlot.value;
		if (existingBubble) {
			// Re-show the hidden bubble at its last dragged position — slots intact
			this._updateArrow();
			existingBubble.show();
			return;
		}

		// Create new bubble positioned in open (unoccupied) space
		const bubble = new ContextBubbleWidget(container);
		this._bubbleSlot.value = bubble;

		const openPos = this._resolveOpenSpacePosition(container);
		bubble.setPosition(openPos.x, openPos.y);

		// Instantiate the three slot components and attach them to the bubble
		this._createSlots(bubble);

		// Draw the initial arrow
		this._updateArrow();

		// Bubble drag → update arrow path in real time (timer keeps running)
		this._sessionDisposables.add(bubble.onDidMove(() => this._updateArrow()));

		// "×" closes bubble AND tears down the full session (including anchor)
		this._sessionDisposables.add(bubble.onDidClose(() => this._teardownSession()));

		bubble.show();
	}

	// -------------------------------------------------------------------------
	// Slot creation and mock data loading
	// -------------------------------------------------------------------------

	private _createSlots(bubble: ContextBubbleWidget): void {
		const container = bubble.getSlotsContainer();
		const symbolName = this._currentSymbolName;

		const callGraph = new CallGraphSlot(container, symbolName);
		const gitHistory = new GitHistorySlot(container);
		const slackMentions = new SlackMentionsSlot(container);

		// Slots are disposed when the session ends
		this._sessionDisposables.add(callGraph);
		this._sessionDisposables.add(gitHistory);
		this._sessionDisposables.add(slackMentions);

		// Staggered mock data delivery — each slot loads independently.
		// Replace setTimeout bodies with real service calls in later sessions.
		// Git history arrives first (fastest — local disk read analogue)
		const t1 = setTimeout(() => {
			gitHistory.renderContent(MOCK_COMMITS);
		}, 380);

		// Call graph arrives second (LSP round-trip analogue)
		const t2 = setTimeout(() => {
			callGraph.renderContent({ callers: MOCK_CALL_GRAPH_CALLERS, callees: MOCK_CALL_GRAPH_CALLEES });
		}, 720);

		// Slack arrives last (network API analogue)
		const t3 = setTimeout(() => {
			slackMentions.renderContent(buildMockSlackMessages(symbolName));
		}, 1100);

		// Cancel pending timeouts if the session is torn down before they fire
		this._sessionDisposables.add({ dispose: () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); } });
	}

	// -------------------------------------------------------------------------
	// Arrow update
	// -------------------------------------------------------------------------

	private _updateArrow(): void {
		const arrow = this._arrowSlot.value;
		const bubble = this._bubbleSlot.value;
		const anchor = this._anchorSlot.value;
		if (!arrow || !bubble) {
			return;
		}

		const container = this._layoutService.getContainer(mainWindow);
		const containerRect = container.getBoundingClientRect();

		// Endpoint B: left edge of bubble, vertically at chrome-bar centre (~23px)
		const bubblePos = bubble.getPosition();
		const to = {
			x: bubblePos.x,
			y: bubblePos.y + 23,
		};

		// Endpoint A: anchor glyph centre, converted to container-relative coords
		if (anchor) {
			const anchorViewport = anchor.getViewportPosition();
			if (anchorViewport) {
				const from = {
					x: anchorViewport.x - containerRect.left,
					y: anchorViewport.y - containerRect.top,
				};
				arrow.update(from, to);
				return;
			}
		}

		// Anchor is off-screen: collapse the path to a point so the arrow is invisible
		arrow.update(to, to);
	}

	// -------------------------------------------------------------------------
	// Open-space placement
	// -------------------------------------------------------------------------

	/**
	 * Computes the initial bubble position in unoccupied horizontal space —
	 * to the right of the editor text content area, vertically aligned near
	 * the anchor line.
	 *
	 * Falls back to a safe position if editor layout is unavailable.
	 */
	private _resolveOpenSpacePosition(container: HTMLElement): { x: number; y: number } {
		const containerRect = container.getBoundingClientRect();
		const editor = this._anchoredEditor;
		const anchor = this._anchorSlot.value;

		const fallback = { x: 60, y: 60 };

		if (!editor) {
			return fallback;
		}

		const editorDomNode = editor.getDomNode();
		if (!editorDomNode) {
			return fallback;
		}

		const editorRect = editorDomNode.getBoundingClientRect();
		const layout = editor.getLayoutInfo();

		// Right edge of text content in container-relative coordinates
		const contentRightContainer =
			editorRect.left + layout.contentLeft + layout.contentWidth - containerRect.left;

		// Place bubble flush against the text right edge with a small gap
		const preferredX = contentRightContainer + 20;
		const maxX = containerRect.width - DEFAULT_WIDTH - 10;
		const x = Math.min(preferredX, Math.max(10, maxX));

		// Vertically: centre the bubble on the anchor line, clamped inside container
		let anchorContainerY = editorRect.top - containerRect.top + 100; // fallback
		if (anchor) {
			const anchorViewport = anchor.getViewportPosition();
			if (anchorViewport) {
				anchorContainerY = anchorViewport.y - containerRect.top;
			}
		}
		const y = Math.max(10, Math.min(
			anchorContainerY - DEFAULT_HEIGHT / 3,
			containerRect.height - DEFAULT_HEIGHT - 10,
		));

		return { x, y };
	}

	// -------------------------------------------------------------------------
	// Session teardown (only called on ×)
	// -------------------------------------------------------------------------

	private _teardownSession(): void {
		this._sessionDisposables.clear();
		this._anchoredEditor = undefined;
		this._currentSymbolName = '';
		this._anchorSlot.value = undefined;
		this._arrowSlot.value = undefined;
		this._bubbleSlot.value = undefined;
	}

	// -------------------------------------------------------------------------
	// Coordinate resolution
	// -------------------------------------------------------------------------

	private _resolveEditorContext(): {
		editor: ICodeEditor;
		lineNumber: number;
		symbolName: string;
	} | undefined {
		const editor = this._codeEditorService.getFocusedCodeEditor()
			?? this._codeEditorService.getActiveCodeEditor();
		if (!editor) {
			return undefined;
		}

		const selection = editor.getSelection();
		if (!selection) {
			return undefined;
		}

		// Capture the symbol name: prefer an active selection, fall back to the
		// word under the cursor so mock data always references a real identifier.
		const model = editor.getModel();
		let symbolName = 'symbol';
		if (model) {
			const selectedText = model.getValueInRange(selection).trim();
			if (selectedText.length > 0) {
				symbolName = selectedText;
			} else {
				const word = model.getWordAtPosition(selection.getStartPosition());
				if (word) {
					symbolName = word.word;
				}
			}
		}

		return {
			editor,
			lineNumber: selection.selectionStartLineNumber,
			symbolName,
		};
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		super.dispose();
	}
}
