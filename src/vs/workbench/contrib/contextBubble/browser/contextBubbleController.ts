/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IPosition, Position } from '../../../../editor/common/core/position.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { CallHierarchyModel } from '../../callHierarchy/common/callHierarchy.js';
import { ContextBubbleWidget } from './contextBubbleWidget.js';
import { ContextBubbleAnchor } from './contextBubbleAnchor.js';
import { ContextBubbleArrow } from './contextBubbleArrow.js';
import {
	SlotComponent,
	ISlotConfig, DEFAULT_SLOT_CONFIG, SlotSourceId, SlotPositionKey,
	SLOT_POSITION_KEYS,
} from './slotComponent.js';
import { CallGraphSlot } from './callGraphSlot.js';
import { GitHistorySlot, MOCK_COMMITS } from './gitHistorySlot.js';
import { SlackMentionsSlot, buildMockSlackMessages } from './slackMentionsSlot.js';
import { SlotConfigOverlay } from './slotConfigOverlay.js';

export const CONTEXT_BUBBLE_COMMAND_ID = 'contextBubble.trigger';

// ---------------------------------------------------------------------------
// Symbol extraction from highlighted function
// ---------------------------------------------------------------------------

/**
 * Modifier/keyword tokens that precede a function or class name in JS/TS declarations.
 * Used to skip past them when scanning for the actual identifier.
 */
const DECLARATION_KEYWORDS = new Set([
	'export', 'default', 'declare', 'abstract', 'async',
	'function', 'class',
	'static', 'public', 'private', 'protected', 'readonly', 'override',
	'const', 'let', 'var',
]);

/**
 * Resolves the symbol name and its precise source position from a highlighted
 * function selection. Three strategies are tried in priority order:
 *
 * 1. Named `function` keyword — catches `function NAME`, `async function NAME`,
 *    `export default async function NAME`, etc., even if preceded by decorators.
 * 2. `class` keyword — catches class declarations.
 * 3. First non-keyword identifier on the declaration line — catches method
 *    shorthands (`processData(items) {`), arrow functions assigned to variables
 *    (`processData = async () => {`), and TypeScript class members.
 *
 * Scans up to {@link HEADER_SCAN_LINES} lines from the top of the selection so
 * that decorators and multi-line signatures are handled correctly.
 *
 * Once the name is found, its exact column on the relevant source line is
 * located so the LSP provider receives a position that lands on the identifier.
 */
const HEADER_SCAN_LINES = 8;

function _resolveSymbolFromSelection(
	model: ITextModel,
	selectionStartLine: number,
	selectionEndLine: number,
): { symbolName: string; position: IPosition } {
	const lastLine = Math.min(selectionEndLine, selectionStartLine + HEADER_SCAN_LINES - 1);

	// Collect the header text (first N lines of the selection joined)
	const headerLines: string[] = [];
	for (let ln = selectionStartLine; ln <= lastLine; ln++) {
		headerLines.push(model.getLineContent(ln));
	}
	const headerText = headerLines.join('\n');

	// Strategy 1 — named function keyword
	const namedFnMatch = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(headerText);
	if (namedFnMatch) {
		return _locateName(model, selectionStartLine, lastLine, namedFnMatch[1]);
	}

	// Strategy 2 — class keyword
	const classMatch = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(headerText);
	if (classMatch) {
		return _locateName(model, selectionStartLine, lastLine, classMatch[1]);
	}

	// Strategy 3 — identifier immediately before '('
	// The function name is always the identifier directly before the parameter list,
	// regardless of what precedes it (modifiers, return-type annotations, etc.).
	// e.g. `private void processData(` → `processData`; `get value(` → `value`.
	const firstLine = model.getLineContent(selectionStartLine);
	const beforeParenRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
	let bpMatch: RegExpExecArray | null;
	while ((bpMatch = beforeParenRe.exec(firstLine)) !== null) {
		if (!DECLARATION_KEYWORDS.has(bpMatch[1])) {
			return {
				symbolName: bpMatch[1],
				position: { lineNumber: selectionStartLine, column: bpMatch.index + 1 },
			};
		}
	}

	// Strategy 4 (fallback) — first non-keyword identifier on the line.
	// Covers arrow functions assigned to variables: `const processData = async () =>`
	// where no identifier immediately precedes `(`.
	const identRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	let match: RegExpExecArray | null;
	while ((match = identRe.exec(firstLine)) !== null) {
		if (!DECLARATION_KEYWORDS.has(match[0])) {
			return {
				symbolName: match[0],
				position: { lineNumber: selectionStartLine, column: match.index + 1 },
			};
		}
	}

	return { symbolName: 'symbol', position: { lineNumber: selectionStartLine, column: 1 } };
}

/**
 * Finds the exact (line, column) of the first whole-word occurrence of `name`
 * within the scanned header lines, so the LSP position lands on the identifier.
 */
function _locateName(
	model: ITextModel,
	startLine: number,
	endLine: number,
	name: string,
): { symbolName: string; position: IPosition } {
	const nameRe = new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`);
	for (let ln = startLine; ln <= endLine; ln++) {
		const text = model.getLineContent(ln);
		const col = text.search(nameRe);
		if (col >= 0) {
			return { symbolName: name, position: { lineNumber: ln, column: col + 1 } };
		}
	}
	return { symbolName: name, position: { lineNumber: startLine, column: 1 } };
}

// ---------------------------------------------------------------------------
// Text-based call graph (last-resort fallback — no LSP required)
// ---------------------------------------------------------------------------

/**
 * Common built-in identifiers that appear before `(` but are not user-defined
 * callees worth surfacing in the call graph.
 */
const TEXT_SEARCH_IGNORE = new Set([
	'if', 'for', 'while', 'switch', 'catch', 'function',
	'console', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
	'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'Error',
	'Math', 'JSON', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
]);

/**
 * Scans the model text directly for callers and callees of `symbolName`.
 * Works without any LSP provider — useful when TypeScript runs in syntax-only
 * mode (no tsconfig.json workspace) and neither CallHierarchyProvider nor
 * ReferenceProvider is registered.
 */
function _fetchCallGraphViaText(
	model: ITextModel,
	symbolName: string,
	declarationLine: number,
): { callers: string[]; callees: string[] } {
	const lineCount = model.getLineCount();
	const safeSymbol = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const callRe = new RegExp(`\\b${safeSymbol}\\s*\\(`);

	// Locate the function body by brace-counting from the declaration line
	const { bodyStart, bodyEnd } = _findFunctionBodyRange(model, declarationLine, lineCount);

	// Callers: occurrences of `symbolName(` outside the function body
	const callerNames = new Set<string>();
	for (let ln = 1; ln <= lineCount; ln++) {
		if (ln >= bodyStart && ln <= bodyEnd) {
			continue;
		}
		if (!callRe.test(model.getLineContent(ln))) {
			continue;
		}
		const enclosing = _findEnclosingFunction(model, ln);
		if (enclosing && enclosing !== symbolName) {
			callerNames.add(enclosing);
		}
	}

	// Callees: all `identifier(` patterns found inside the function body
	const calleeRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
	const calleeNames = new Set<string>();
	for (let ln = bodyStart; ln <= bodyEnd; ln++) {
		const text = model.getLineContent(ln);
		let m: RegExpExecArray | null;
		while ((m = calleeRe.exec(text)) !== null) {
			const name = m[1];
			if (name !== symbolName && !DECLARATION_KEYWORDS.has(name) && !TEXT_SEARCH_IGNORE.has(name)) {
				calleeNames.add(name);
			}
		}
	}

	return { callers: [...callerNames], callees: [...calleeNames] };
}

/**
 * Finds the line range of the function body that starts at or after
 * `declarationLine` using brace counting.
 */
function _findFunctionBodyRange(
	model: ITextModel,
	declarationLine: number,
	lineCount: number,
): { bodyStart: number; bodyEnd: number } {
	let depth = 0;
	let bodyStart = declarationLine;
	let bodyEnd = declarationLine;
	let opened = false;

	for (let ln = declarationLine; ln <= Math.min(lineCount, declarationLine + 2000); ln++) {
		const text = model.getLineContent(ln);
		for (const ch of text) {
			if (ch === '{') {
				if (!opened) {
					bodyStart = ln;
					opened = true;
				}
				depth++;
			} else if (ch === '}') {
				depth--;
				if (opened && depth === 0) {
					bodyEnd = ln;
					return { bodyStart, bodyEnd };
				}
			}
		}
	}
	return { bodyStart, bodyEnd };
}

/**
 * Scans backwards from `callLine` to find the nearest enclosing function/method
 * declaration. Uses the same multi-strategy extraction as `_resolveSymbolFromSelection`.
 */
function _findEnclosingFunction(model: ITextModel, callLine: number): string | undefined {
	const NAMED_FN = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
	const CLASS_RE = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
	const BEFORE_PAREN = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

	for (let ln = callLine - 1; ln >= Math.max(1, callLine - 300); ln--) {
		const text = model.getLineContent(ln);

		const namedFn = NAMED_FN.exec(text);
		if (namedFn) {
			return namedFn[1];
		}

		const classDecl = CLASS_RE.exec(text);
		if (classDecl) {
			return classDecl[1];
		}

		// Method shorthand: only consider lines that open a scope
		if (text.includes('{')) {
			const bp = BEFORE_PAREN.exec(text);
			if (bp && !DECLARATION_KEYWORDS.has(bp[1]) && !TEXT_SEARCH_IGNORE.has(bp[1])) {
				return bp[1];
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Reference-based call graph helpers (fallback when CallHierarchyProvider absent)
// ---------------------------------------------------------------------------

/**
 * Walks a DocumentSymbol tree to find the name of the deepest function/method/
 * constructor whose range contains `refRange`. Used to convert raw reference
 * locations into caller function names.
 */
function _findContainingFunctionName(symbols: DocumentSymbol[], refRange: IRange): string | undefined {
	for (const sym of symbols) {
		if (_rangeContains(sym.range, refRange)) {
			const fromChild = _findContainingFunctionName(sym.children ?? [], refRange);
			if (fromChild !== undefined) {
				return fromChild;
			}
			if (
				sym.kind === SymbolKind.Function ||
				sym.kind === SymbolKind.Method ||
				sym.kind === SymbolKind.Constructor
			) {
				return sym.name;
			}
		}
	}
	return undefined;
}

function _rangeContains(outer: IRange, inner: IRange): boolean {
	if (inner.startLineNumber < outer.startLineNumber || inner.endLineNumber > outer.endLineNumber) {
		return false;
	}
	if (inner.startLineNumber === outer.startLineNumber && inner.startColumn < outer.startColumn) {
		return false;
	}
	if (inner.endLineNumber === outer.endLineNumber && inner.endColumn > outer.endColumn) {
		return false;
	}
	return true;
}

/** Default bubble dimensions — kept in sync with constants in contextBubbleWidget.ts. */
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 460;

// ---------------------------------------------------------------------------
// Slot factory map — adding a new data source means adding one entry here
// ---------------------------------------------------------------------------

type SlotFactory = (container: HTMLElement, symbolName: string) => SlotComponent;

const SLOT_FACTORIES: Record<SlotSourceId, SlotFactory> = {
	'contextBubble.callGraph': (container, symbolName) => new CallGraphSlot(container, symbolName),
	'contextBubble.gitHistory': (container, _symbolName) => new GitHistorySlot(container),
	'contextBubble.slackMentions': (container, _symbolName) => new SlackMentionsSlot(container),
};

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

	/** Editor model and cursor position captured at trigger time — used for LSP call hierarchy. */
	private _currentModel: ITextModel | null = null;
	private _currentPosition: IPosition | null = null;

	/**
	 * All three slot instances keyed by source ID.
	 * Preserved across layout rearrangements so data is not re-fetched.
	 */
	private readonly _slotInstances = new Map<SlotSourceId, SlotComponent>();

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IModelService private readonly _modelService: IModelService,
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
		this._currentModel = editorContext.model;
		this._currentPosition = editorContext.position;

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

		// Bubble drag → update arrow path in real time
		this._sessionDisposables.add(bubble.onDidMove(() => this._updateArrow()));

		// "×" closes bubble AND tears down the full session (including anchor)
		this._sessionDisposables.add(bubble.onDidClose(() => this._teardownSession()));

		// Gear icon → open slot config overlay
		this._sessionDisposables.add(bubble.onDidRequestConfig(() => this._openConfigOverlay(bubble)));

		bubble.show();
	}

	// -------------------------------------------------------------------------
	// Slot creation
	// -------------------------------------------------------------------------

	private _createSlots(bubble: ContextBubbleWidget): void {
		const symbolName = this._currentSymbolName;
		const config = this._readSlotConfig();

		// Create all instances using a detached container so they don't appear in
		// the DOM until _applyLayout() positions them in the correct order.
		const detached = document.createElement('div');

		for (const sourceId of Object.keys(SLOT_FACTORIES) as SlotSourceId[]) {
			const slot = SLOT_FACTORIES[sourceId](detached, symbolName);
			this._slotInstances.set(sourceId, slot);
			this._sessionDisposables.add(slot);
		}

		// Position slots according to saved config
		this._applyLayout(bubble, config);

		// Staggered mock data for git and slack — each slot loads independently.
		const t1 = setTimeout(() => {
			this._slotInstances.get('contextBubble.gitHistory')?.renderContent(MOCK_COMMITS);
		}, 380);

		const t3 = setTimeout(() => {
			this._slotInstances.get('contextBubble.slackMentions')?.renderContent(
				buildMockSlackMessages(symbolName)
			);
		}, 1100);

		// Cancel pending timeouts if the session is torn down before they fire
		this._sessionDisposables.add({
			dispose: () => { clearTimeout(t1); clearTimeout(t3); },
		});

		// Call graph — real LSP data via CallHierarchyModel
		this._fetchCallGraph();
	}

	// -------------------------------------------------------------------------
	// Call graph — LSP fetch
	// -------------------------------------------------------------------------

	private _fetchCallGraph(): void {
		const model = this._currentModel;
		const position = this._currentPosition;
		const slot = this._slotInstances.get('contextBubble.callGraph');
		if (!slot || !model || !position) {
			// No model/position available — render centre node only
			slot?.renderContent({ callers: [], callees: [] });
			return;
		}

		const cts = new CancellationTokenSource();
		this._sessionDisposables.add({ dispose: () => cts.dispose(true) });

		const doFetch = async () => {
			// Preferred: CallHierarchyProvider — requires TypeScript semantic mode
			const hierarchy = await CallHierarchyModel.create(model, position, cts.token);
			if (cts.token.isCancellationRequested) {
				return;
			}

			if (hierarchy) {
				try {
					const [incoming, outgoing] = await Promise.all([
						hierarchy.resolveIncomingCalls(hierarchy.root, cts.token),
						hierarchy.resolveOutgoingCalls(hierarchy.root, cts.token),
					]);
					if (cts.token.isCancellationRequested) {
						return;
					}
					slot.renderContent({
						callers: incoming.map(c => c.from.name),
						callees: outgoing.map(c => c.to.name),
					});
				} finally {
					hierarchy.dispose();
				}
				return;
			}

			// Fallback 1: ReferenceProvider + DocumentSymbolProvider.
			// Used when TypeScript runs in syntax-only mode and has not registered
			// a CallHierarchyProvider (e.g. no tsconfig.json, no semantic server).
			const lspResult = await this._fetchCallersViaReferences(model, position, cts.token);
			if (cts.token.isCancellationRequested) {
				return;
			}
			if (lspResult.callers.length > 0) {
				slot.renderContent(lspResult);
				return;
			}

			// Fallback 2: pure text search — no LSP required. Scans the document
			// for call sites and function bodies directly. Always produces results
			// as long as the symbol name was resolved correctly.
			const symbolName = this._currentSymbolName;
			if (symbolName && symbolName !== 'symbol') {
				slot.renderContent(_fetchCallGraphViaText(model, symbolName, position.lineNumber));
			} else {
				slot.renderContent({ callers: [], callees: [] });
			}
		};

		doFetch().catch(() => {
			if (!cts.token.isCancellationRequested) {
				slot.setState('error');
			}
		});
	}

	/**
	 * Fallback call graph fetch using ReferenceProvider (callers) and
	 * DocumentSymbolProvider (to map call-site locations → function names).
	 * Callees are not available via this path and will be empty.
	 */
	private async _fetchCallersViaReferences(
		model: ITextModel,
		position: IPosition,
		token: CancellationToken,
	): Promise<{ callers: string[]; callees: string[] }> {
		const [refProvider] = this._languageFeaturesService.referenceProvider.ordered(model);
		if (!refProvider) {
			return { callers: [], callees: [] };
		}

		const pos = new Position(position.lineNumber, position.column);
		const refs = await refProvider.provideReferences(
			model, pos, { includeDeclaration: false }, token
		) ?? [];

		if (token.isCancellationRequested || refs.length === 0) {
			return { callers: [], callees: [] };
		}

		// Group by file to avoid redundant document-symbol lookups
		const byFile = new Map<string, { fileModel: ITextModel | null; ranges: IRange[] }>();
		for (const ref of refs) {
			const key = ref.uri.toString();
			if (!byFile.has(key)) {
				const fileModel = key === model.uri.toString()
					? model
					: this._modelService.getModel(ref.uri);
				byFile.set(key, { fileModel, ranges: [] });
			}
			byFile.get(key)!.ranges.push(ref.range);
		}

		const callerNames = new Set<string>();

		for (const [fileKey, { fileModel, ranges }] of byFile.entries()) {
			if (token.isCancellationRequested) {
				break;
			}

			if (fileModel) {
				const [symProvider] = this._languageFeaturesService.documentSymbolProvider.ordered(fileModel);
				if (symProvider) {
					const symbols = await symProvider.provideDocumentSymbols(fileModel, token) ?? [];
					if (!token.isCancellationRequested) {
						for (const range of ranges) {
							const name = _findContainingFunctionName(symbols, range);
							if (name) {
								callerNames.add(name);
							}
						}
					}
					continue;
				}
			}

			// Model not loaded or no symbol provider — use the filename as the caller label
			const filename = fileKey.split('/').pop()?.replace(/\.[^.]+$/, '');
			if (filename) {
				callerNames.add(filename);
			}
		}

		return { callers: [...callerNames], callees: [] };
	}

	// -------------------------------------------------------------------------
	// Layout application
	// -------------------------------------------------------------------------

	/**
	 * Re-orders slot DOM elements inside the bubble's slots container according
	 * to the given config. Slot instances are preserved — data is not re-fetched.
	 */
	private _applyLayout(bubble: ContextBubbleWidget, config: ISlotConfig): void {
		const container = bubble.getSlotsContainer();

		// Remove existing children without disposing — just detaching for re-ordering
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}

		// Apply preset identifier so CSS grid/flex rules activate
		container.dataset['preset'] = config.preset;

		// fullBleed only exposes slot.top
		const positions: SlotPositionKey[] = config.preset === 'fullBleed'
			? ['slot.top']
			: SLOT_POSITION_KEYS;

		for (const posKey of positions) {
			const sourceId = config.assignments[posKey];
			const slot = sourceId ? this._slotInstances.get(sourceId) : undefined;

			if (slot) {
				container.appendChild(slot.domElement);
			} else {
				// Empty placeholder maintains grid area for unassigned positions
				const ph = document.createElement('div');
				ph.className = 'context-bubble-slot';
				container.appendChild(ph);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Configuration read / write
	// -------------------------------------------------------------------------

	private _readSlotConfig(): ISlotConfig {
		const raw = this._configurationService.getValue<ISlotConfig>('contextBubble.slotLayout');
		if (!raw || typeof raw !== 'object' || !raw.preset || !raw.assignments) {
			return DEFAULT_SLOT_CONFIG;
		}
		return raw;
	}

	// -------------------------------------------------------------------------
	// Config overlay
	// -------------------------------------------------------------------------

	private _openConfigOverlay(bubble: ContextBubbleWidget): void {
		const currentConfig = this._readSlotConfig();
		const overlay = new SlotConfigOverlay(bubble.element, currentConfig);
		this._sessionDisposables.add(overlay);

		this._sessionDisposables.add(overlay.onDidConfirm(choice => {
			const newConfig: ISlotConfig = {
				preset: choice.preset,
				assignments: choice.assignments,
			};
			// Persist immediately — fire-and-forget; fallback to defaults on failure
			this._configurationService.updateValue(
				'contextBubble.slotLayout', newConfig, ConfigurationTarget.USER
			).then(undefined, () => { /* ignore write errors */ });

			// Re-order existing slot DOM without re-fetching data
			this._applyLayout(bubble, newConfig);
		}));
		// onDidCancel: overlay disposes itself, no other action needed
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
		this._slotInstances.clear();
		this._anchoredEditor = undefined;
		this._currentSymbolName = '';
		this._currentModel = null;
		this._currentPosition = null;
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
		model: ITextModel | null;
		position: IPosition;
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

		// The trigger is always a highlighted function — extract the symbol name
		// and LSP position from the selection. startLineNumber is the topmost line
		// regardless of drag direction, which is where the declaration lives.
		const model = editor.getModel();
		const { symbolName, position } = model
			? _resolveSymbolFromSelection(model, selection.startLineNumber, selection.endLineNumber)
			: { symbolName: 'symbol', position: selection.getStartPosition() };

		return {
			editor,
			lineNumber: selection.selectionStartLineNumber,
			symbolName,
			model,
			position,
		};
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		super.dispose();
	}
}
