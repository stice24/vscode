/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { GlyphMarginLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { mainWindow } from '../../../../base/browser/window.js';

// ---------------------------------------------------------------------------
// Style injection — runs once per page lifetime
// ---------------------------------------------------------------------------

let _stylesInjected = false;

function ensureAnchorStyles(): void {
	if (_stylesInjected) {
		return;
	}
	_stylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `
.context-bubble-anchor-glyph {
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
}
.context-bubble-anchor-glyph::before {
	content: "+";
	color: #4ec9b0;
	font-size: 13px;
	font-weight: 700;
	font-family: monospace;
	line-height: 1;
}
.context-bubble-anchor-label::after {
	content: "Context Bubble";
	color: rgba(78, 201, 176, 0.38);
	font-size: 10px;
	font-family: system-ui, -apple-system, sans-serif;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	margin-left: 10px;
	padding: 1px 7px;
	border-radius: 4px;
	border: 1px solid rgba(78, 201, 176, 0.15);
	background: rgba(78, 201, 176, 0.04);
	vertical-align: middle;
	pointer-events: none;
}
`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

/**
 * A gutter decoration anchored to the trigger line.
 *
 * Responsibilities:
 * - Renders a "+" glyph in the glyph margin via the editor decoration API
 * - Renders a "Context Bubble" label inline after the code text
 * - Scrolls with the code (the decoration system owns scroll tracking)
 * - Fires `onDidClick` when the user clicks the "+" glyph
 * - Removed entirely when the bubble is closed (dispose clears the decoration)
 */
export class ContextBubbleAnchor extends Disposable {

	private readonly _decoration: IEditorDecorationsCollection;
	private readonly _onDidClick = this._register(new Emitter<void>());

	/** Fires when the user clicks the anchor glyph. */
	readonly onDidClick: Event<void> = this._onDidClick.event;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _lineNumber: number,
	) {
		super();
		ensureAnchorStyles();

		this._decoration = this._editor.createDecorationsCollection();
		this._applyDecoration();

		this._register(this._editor.onMouseDown(e => this._handleMouseDown(e)));
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Returns the current viewport-relative screen position of the anchor glyph
	 * centre, accounting for editor scroll. Returns `undefined` when the anchor
	 * line is outside the visible viewport.
	 */
	getViewportPosition(): { x: number; y: number } | undefined {
		const editorDomNode = this._editor.getDomNode();
		if (!editorDomNode) {
			return undefined;
		}
		const scrolledPos = this._editor.getScrolledVisiblePosition({
			lineNumber: this._lineNumber,
			column: 1,
		});
		if (!scrolledPos) {
			return undefined;
		}
		const editorRect = editorDomNode.getBoundingClientRect();
		const layout = this._editor.getLayoutInfo();

		return {
			// Horizontal centre of the glyph margin column
			x: editorRect.left + layout.glyphMarginLeft + layout.glyphMarginWidth / 2,
			// Vertical centre of the trigger line
			y: editorRect.top + scrolledPos.top + scrolledPos.height / 2,
		};
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	private _applyDecoration(): void {
		const model = this._editor.getModel();
		const endColumn = model ? model.getLineMaxColumn(this._lineNumber) : 1;

		this._decoration.set([{
			range: {
				startLineNumber: this._lineNumber,
				startColumn: 1,
				endLineNumber: this._lineNumber,
				endColumn,
			},
			options: {
				description: 'context-bubble-anchor',
				glyphMarginClassName: 'context-bubble-anchor-glyph',
				glyphMargin: { position: GlyphMarginLane.Left },
				afterContentClassName: 'context-bubble-anchor-label',
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			},
		}]);
	}

	private _handleMouseDown(e: IEditorMouseEvent): void {
		if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) {
			return;
		}
		if (!e.target.position || e.target.position.lineNumber !== this._lineNumber) {
			return;
		}
		this._onDidClick.fire();
	}

	override dispose(): void {
		this._decoration.clear();
		super.dispose();
	}
}
