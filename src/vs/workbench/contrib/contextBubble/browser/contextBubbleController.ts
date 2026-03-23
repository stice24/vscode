/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextBubbleWidget } from './contextBubbleWidget.js';

export const CONTEXT_BUBBLE_COMMAND_ID = 'contextBubble.trigger';

/**
 * Workbench contribution that owns the context bubble lifecycle.
 *
 * Responsibilities:
 * - Registers the command that the keybinding fires
 * - Resolves the active editor and highlighted symbol position on trigger
 * - Owns the single ContextBubbleWidget instance (one bubble at a time, UX constraint)
 * - Handles re-expand when a hidden bubble already exists
 */
export class ContextBubbleController extends Disposable {

	static readonly ID = 'workbench.contrib.contextBubble';

	/**
	 * MutableDisposable ensures previous bubble is fully cleaned up before a new
	 * one is created, and is disposed automatically when the controller shuts down.
	 * Do not use `this._register(new ContextBubbleWidget(...))` inside a
	 * repeatedly-called method — that would accumulate stale disposables.
	 */
	private readonly _bubbleSlot = this._register(new MutableDisposable<ContextBubbleWidget>());

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
	) {
		super();

		// Register the command handler. The keybinding rule (defined in
		// contextBubble.contribution.ts) binds the hotkey to this command ID.
		this._register(CommandsRegistry.registerCommand(CONTEXT_BUBBLE_COMMAND_ID, () => {
			this._triggerBubble();
		}));
	}

	// -------------------------------------------------------------------------
	// Trigger
	// -------------------------------------------------------------------------

	private _triggerBubble(): void {
		const existing = this._bubbleSlot.value;

		// Re-expand a hidden bubble instead of creating a new one
		if (existing && !existing.isVisible) {
			existing.show();
			return;
		}

		// Only one bubble at a time — assigning a new value disposes the previous one
		const position = this._resolveSymbolScreenPosition();
		const container = this._layoutService.getContainer(mainWindow);

		const bubble = new ContextBubbleWidget(container);
		this._bubbleSlot.value = bubble;

		if (position) {
			// Offset the bubble slightly right and below the trigger line
			const containerRect = container.getBoundingClientRect();
			const bubbleX = Math.max(0, position.viewportX - containerRect.left + 24);
			const bubbleY = Math.max(0, position.viewportY - containerRect.top);
			bubble.setPosition(bubbleX, bubbleY);
		}

		bubble.show();
	}

	// -------------------------------------------------------------------------
	// Coordinate resolution
	// -------------------------------------------------------------------------

	/**
	 * Resolves the viewport-relative screen position of the start of the
	 * current editor selection, using existing editor infrastructure.
	 *
	 * Combination of:
	 * - `ICodeEditor.getScrolledVisiblePosition` — position relative to editor DOM node
	 * - `getBoundingClientRect` on the editor DOM node — editor's viewport position
	 *
	 * Returns `undefined` when no focused editor or selection is available.
	 */
	private _resolveSymbolScreenPosition(): { viewportX: number; viewportY: number } | undefined {
		// Prefer the focused editor (user just interacted with it)
		const editor = this._codeEditorService.getFocusedCodeEditor()
			?? this._codeEditorService.getActiveCodeEditor();

		if (!editor) {
			return undefined;
		}

		const selection = editor.getSelection();
		if (!selection) {
			return undefined;
		}

		// getScrolledVisiblePosition returns coordinates relative to the editor
		// DOM node's top-left corner, accounting for current scroll offset.
		const scrolledPos = editor.getScrolledVisiblePosition({
			lineNumber: selection.selectionStartLineNumber,
			column: selection.selectionStartColumn,
		});
		if (!scrolledPos) {
			return undefined;
		}

		const editorDomNode = editor.getDomNode();
		if (!editorDomNode) {
			return undefined;
		}

		// getBoundingClientRect converts to viewport-relative coordinates
		const editorRect = editorDomNode.getBoundingClientRect();

		return {
			viewportX: editorRect.left + scrolledPos.left,
			// Place the bubble just below the trigger line
			viewportY: editorRect.top + scrolledPos.top + scrolledPos.height,
		};
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		// _bubbleSlot is registered and will be disposed by super.dispose()
		super.dispose();
	}
}
