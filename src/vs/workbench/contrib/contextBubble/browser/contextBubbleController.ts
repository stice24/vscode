/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISCMService } from '../../scm/common/scm.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { CallHierarchyModel } from '../../callHierarchy/common/callHierarchy.js';
import { ContextBubbleWidget } from './contextBubbleWidget.js';
import { ContextBubbleAnchor } from './contextBubbleAnchor.js';
import { ContextBubbleArrow } from './contextBubbleArrow.js';
import { PartialSelectionPrompt } from './contextSelectionPrompt.js';
import {
	SlotComponent,
	ISlotConfig, DEFAULT_SLOT_CONFIG, SlotSourceId, SlotPositionKey,
	SLOT_POSITION_KEYS,
} from './slotComponent.js';
import { CallGraphSlot, CallGraphData } from './callGraphSlot.js';
import { GitHistorySlot, CommitEntry } from './gitHistorySlot.js';
import { SlackMentionsSlot, SlackMessage } from './slackMentionsSlot.js';
import { SlotConfigOverlay } from './slotConfigOverlay.js';
import * as nls from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';

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

/**
 * Scans `model` line-by-line for a declaration of `name`. Prioritises
 * `function name(` over bare `name(` so call sites are not mistaken for
 * declarations. Returns the 1-based line number, or `undefined` if not found.
 */
function _findDeclarationLine(model: ITextModel, name: string): number | undefined {
	const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Named function / async function declaration
	const namedFnRe = new RegExp(`\\bfunction\\s+${safe}\\b`);
	// Arrow / const assignment: `const name =` or `name =`
	const assignRe = new RegExp(`\\b${safe}\\s*=`);
	// Method shorthand in a class body: `name(` on a line that opens a block
	const methodRe = new RegExp(`\\b${safe}\\s*\\(`);

	let methodFallback: number | undefined;

	for (let ln = 1; ln <= model.getLineCount(); ln++) {
		const text = model.getLineContent(ln);
		if (namedFnRe.test(text)) {
			return ln;
		}
		if (assignRe.test(text)) {
			return ln;
		}
		if (methodFallback === undefined && methodRe.test(text) && text.includes('{')) {
			methodFallback = ln;
		}
	}
	return methodFallback;
}

// ---------------------------------------------------------------------------
// Reference-based call graph helpers (fallback when CallHierarchyProvider absent)
// ---------------------------------------------------------------------------

/**
 * Walks a DocumentSymbol tree to find the deepest function/method/constructor
 * whose range contains `refRange`. Returns the full symbol so callers can use
 * both the name and the selectionRange for navigation.
 */
function _findContainingFunction(symbols: DocumentSymbol[], refRange: IRange): DocumentSymbol | undefined {
	for (const sym of symbols) {
		if (_rangeContains(sym.range, refRange)) {
			const fromChild = _findContainingFunction(sym.children ?? [], refRange);
			if (fromChild !== undefined) {
				return fromChild;
			}
			if (
				sym.kind === SymbolKind.Function ||
				sym.kind === SymbolKind.Method ||
				sym.kind === SymbolKind.Constructor
			) {
				return sym;
			}
		}
	}
	return undefined;
}

function _formatRelativeTime(timestampMs: number | undefined): string {
	if (timestampMs === undefined) { return ''; }
	const diffSec = Math.floor((Date.now() - timestampMs) / 1000);
	if (diffSec < 60) { return 'just now'; }
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) { return `${diffMin}m ago`; }
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) { return `${diffHr}h ago`; }
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) { return `${diffDay}d ago`; }
	const diffWk = Math.floor(diffDay / 7);
	if (diffWk < 52) { return `${diffWk}w ago`; }
	return `${Math.floor(diffWk / 52)}y ago`;
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

function _rangesEqual(a: IRange, b: IRange): boolean {
	return a.startLineNumber === b.startLineNumber
		&& a.startColumn === b.startColumn
		&& a.endLineNumber === b.endLineNumber
		&& a.endColumn === b.endColumn;
}

/**
 * Walks a DocumentSymbol tree to find the deepest function, method, constructor,
 * or class whose range fully contains `selectionRange`.
 * Returns `undefined` when no single symbol encloses the entire selection
 * (i.e. the selection spans multiple top-level symbols or falls outside all of them).
 */
function _findEnclosingFunctionOrClass(symbols: DocumentSymbol[], selectionRange: IRange): DocumentSymbol | undefined {
	for (const sym of symbols) {
		if (_rangeContains(sym.range, selectionRange)) {
			const fromChild = _findEnclosingFunctionOrClass(sym.children ?? [], selectionRange);
			if (fromChild !== undefined) {
				return fromChild;
			}
			if (
				sym.kind === SymbolKind.Function ||
				sym.kind === SymbolKind.Method ||
				sym.kind === SymbolKind.Constructor ||
				sym.kind === SymbolKind.Class
			) {
				return sym;
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Dependency graph helpers (class mode)
// ---------------------------------------------------------------------------

/**
 * Extracts the primary imported identifier from an import statement line.
 * Handles named imports `{ X, Y }` (returns X), default imports `import X`,
 * and namespace imports `import * as X`. Falls back to the URI basename.
 *
 * The link provider gives us the range of the import path string; we inspect
 * the same source line to extract the imported name, which is more meaningful
 * as a node label than the module path.
 */
function _extractImportedName(lineText: string, fallbackUri: URI): string {
	// Named imports: import { AuthService } from '...'  or  import { A, B } from '...'
	const namedMatch = /import\s+(?:type\s+)?\{([^}]+)\}/.exec(lineText);
	if (namedMatch) {
		const first = namedMatch[1].split(',')[0].trim();
		// Handle aliasing: `AuthService as Auth` → take the exported name (AuthService)
		const beforeAs = first.split(/\s+as\s+/)[0].trim();
		if (beforeAs) {
			return beforeAs;
		}
	}
	// Namespace import: import * as ns from '...'
	const starMatch = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(lineText);
	if (starMatch) {
		return starMatch[1];
	}
	// Default import: import Name from '...'  (not a keyword, not '*')
	const defaultMatch = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(lineText);
	if (defaultMatch && defaultMatch[1] !== 'type') {
		return defaultMatch[1];
	}
	return _fileBasename(fallbackUri);
}

/** Strips the directory path and file extension from a URI, returning the bare module name. */
function _fileBasename(uri: URI): string {
	const base = uri.path.split('/').pop() ?? '';
	return base.replace(/\.[^.]+$/, '');
}

/** Default bubble dimensions — kept in sync with constants in contextBubbleWidget.ts. */
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 460;

// ---------------------------------------------------------------------------
// Slot factory map — adding a new data source means adding one entry here.
// Note: callGraph and slackMentions are created explicitly in _createSlots()
// so that extra construction-time arguments can be passed.
// ---------------------------------------------------------------------------

type SlotFactory = (container: HTMLElement, symbolName: string) => SlotComponent;

const SLOT_FACTORIES: Partial<Record<SlotSourceId, SlotFactory>> = {
	'contextBubble.gitHistory': (container, _symbolName) => new GitHistorySlot(container),
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
	 * The active partial-selection prompt, if any. Only one can exist at a time.
	 * Replaced (and the previous one disposed) whenever a new trigger starts.
	 */
	private readonly _promptSlot = this._register(new MutableDisposable<DisposableStore>());

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

	/**
	 * Symbol type determined at trigger time. Set from a fast regex hint first,
	 * then overridden by the DocumentSymbolProvider result in
	 * `_checkPartialSelectionAndMaybeTrigger`. Invariant once the bubble is open
	 * — does not change during cmd-click navigation within a session.
	 */
	private _currentSymbolType: 'function' | 'class' = 'function';

	/** Editor model and cursor position captured at trigger time — used for LSP call hierarchy. */
	private _currentModel: ITextModel | null = null;
	private _currentPosition: IPosition | null = null;

	/**
	 * Symbol → location map built when call graph data is fetched.
	 * Used to navigate to a node when the user cmd-clicks it.
	 */
	private readonly _callNodeLocations = new Map<string, { uri: URI; selectionRange: IRange }>();

	/**
	 * All three slot instances keyed by source ID.
	 * Preserved across layout rearrangements so data is not re-fetched.
	 */
	private readonly _slotInstances = new Map<SlotSourceId, SlotComponent>();

	/**
	 * Navigation history for back/forward traversal of call-graph nodes.
	 * Each entry captures the full controller state needed to restore a previous
	 * symbol: its name, cached graph data, source file URI, and cursor position.
	 * Managed in sync with the visual history bar in CallGraphSlot.
	 */
	private _navBackStack: Array<{ symbolName: string; data: CallGraphData; uri: string; lineNumber: number; column: number }> = [];
	private _navForwardStack: Array<{ symbolName: string; data: CallGraphData; uri: string; lineNumber: number; column: number }> = [];

	/** Slack user token loaded from secret storage. Cached for the session lifetime. */
	private _slackToken: string | undefined;

	/**
	 * Channel list fetched once after connect and cached in memory.
	 * Re-used by the channel picker — never re-fetched on every keystroke.
	 */
	private _slackChannels: { id: string; name: string }[] = [];

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IModelService private readonly _modelService: IModelService,
		@IEditorService private readonly _editorService: IEditorService,
		@ISCMService private readonly _scmService: ISCMService,
		@IStorageService private readonly _storageService: IStorageService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(CONTEXT_BUBBLE_COMMAND_ID, () => {
			this._triggerBubble();
		}));
		this._register(CommandsRegistry.registerCommand('contextBubble.testSlackConnection', () => {
			this._testSlackConnection();
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

		const editorContext = this._resolveEditorContext();
		if (!editorContext) {
			return;
		}

		// Dismiss any existing partial-selection prompt before starting a new check
		this._promptSlot.value = undefined;

		// Apply the fast regex hint immediately so the catch/fallback path has a
		// reasonable value even if the async LSP check never runs.
		this._currentSymbolType = editorContext.symbolTypeHint;

		// Async partial-selection check — places the anchor when done.
		// Falls back to normal anchor placement if the symbol check throws.
		this._checkPartialSelectionAndMaybeTrigger(editorContext).catch(() => {
			if (!this._anchorSlot.value) {
				this._placeAnchor(editorContext);
			}
		});
	}

	/**
	 * Queries DocumentSymbolProvider for the current model. If the editor selection
	 * is a strict subset of a single enclosing function or class, shows the partial-
	 * selection prompt instead of immediately placing the anchor. Otherwise calls
	 * `_placeAnchor` directly.
	 */
	private async _checkPartialSelectionAndMaybeTrigger(editorContext: {
		editor: ICodeEditor;
		lineNumber: number;
		selectionRange: IRange;
		symbolName: string;
		model: ITextModel | null;
		position: IPosition;
	}): Promise<void> {
		const { model, selectionRange, editor } = editorContext;

		if (!model) {
			this._placeAnchor(editorContext);
			return;
		}

		const [symProvider] = this._languageFeaturesService.documentSymbolProvider.ordered(model);
		if (!symProvider) {
			this._placeAnchor(editorContext);
			return;
		}

		const cts = new CancellationTokenSource();
		let symbols: DocumentSymbol[];
		try {
			symbols = await symProvider.provideDocumentSymbols(model, cts.token) ?? [];
		} catch {
			cts.dispose(true);
			if (!this._anchorSlot.value) {
				this._placeAnchor(editorContext);
			}
			return;
		}
		cts.dispose();

		// If the trigger context changed while awaiting (user pressed hotkey again,
		// anchor placed by another code path), do nothing.
		if (this._anchorSlot.value) {
			return;
		}

		const enclosing = _findEnclosingFunctionOrClass(symbols, selectionRange);

		if (!enclosing) {
			// No single symbol fully contains the selection (spans multiple or none) → normal
			this._placeAnchor(editorContext);
			return;
		}

		// Override the regex hint with the authoritative LSP kind.
		if (
			enclosing.kind === SymbolKind.Class ||
			enclosing.kind === SymbolKind.Interface ||
			enclosing.kind === SymbolKind.Enum
		) {
			this._currentSymbolType = 'class';
		} else {
			this._currentSymbolType = 'function';
		}

		if (_rangesEqual(selectionRange, enclosing.range)) {
			// Selection already covers the full symbol → normal
			this._placeAnchor(editorContext);
			return;
		}

		// Partial selection — show the prompt
		this._showPartialPrompt(editor, selectionRange, enclosing);
	}

	/** Places the gutter anchor and wires its click handler. Extracted so both the
	 *  direct hotkey path and the prompt's confirm path share the same logic. */
	private _placeAnchor(editorContext: {
		editor: ICodeEditor;
		lineNumber: number;
		symbolName: string;
		model: ITextModel | null;
		position: IPosition;
	}): void {
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

	/**
	 * Creates and displays the partial-selection prompt adjacent to the end of
	 * the selection. Wires the confirm (expand) and dismiss actions.
	 */
	private _showPartialPrompt(
		editor: ICodeEditor,
		selectionRange: IRange,
		symbol: DocumentSymbol,
	): void {
		const container = this._layoutService.getContainer(mainWindow);
		const containerRect = container.getBoundingClientRect();
		const editorDomNode = editor.getDomNode();
		if (!editorDomNode) {
			return;
		}

		const editorRect = editorDomNode.getBoundingClientRect();
		const layout = editor.getLayoutInfo();
		const scrolledPos = editor.getScrolledVisiblePosition({
			lineNumber: selectionRange.endLineNumber,
			column: selectionRange.endColumn,
		});

		if (!scrolledPos) {
			// End of selection is outside the visible viewport — fall through to normal
			const editorContext = this._resolveEditorContext();
			if (editorContext && !this._anchorSlot.value) {
				this._placeAnchor(editorContext);
			}
			return;
		}

		// Position the prompt just below the selection end, horizontally aligned
		// with the end character, clamped so it stays within the container.
		const rawX = editorRect.left + layout.contentLeft + scrolledPos.left - containerRect.left;
		const rawY = editorRect.top + scrolledPos.top + scrolledPos.height - containerRect.top + 6;
		const x = Math.max(4, Math.min(rawX, containerRect.width - 280));
		const y = Math.max(4, Math.min(rawY, containerRect.height - 40));

		const store = new DisposableStore();
		const prompt = store.add(new PartialSelectionPrompt(container, x, y, symbol.name));

		store.add(prompt.onDidSelectSymbol(() => {
			// Expand selection to the full symbol range, then re-trigger normally
			this._promptSlot.value = undefined;
			editor.setSelection({
				startLineNumber: symbol.range.startLineNumber,
				startColumn: symbol.range.startColumn,
				endLineNumber: symbol.range.endLineNumber,
				endColumn: symbol.range.endColumn,
			});
			this._triggerBubble();
		}));

		store.add(prompt.onDidDismiss(() => {
			this._promptSlot.value = undefined;
		}));

		this._promptSlot.value = store;
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

		// Call graph — created explicitly so symbolType can be passed at construction.
		// The slot label ("Call Graph" vs "Dependencies") and empty-state text are
		// determined by symbolType and do not change during the session.
		const callGraphSlot = new CallGraphSlot(detached, symbolName, this._currentSymbolType);
		this._slotInstances.set('contextBubble.callGraph', callGraphSlot);
		this._sessionDisposables.add(callGraphSlot);

		// Git history and any other factory-mapped slots.
		for (const [sourceId, factory] of Object.entries(SLOT_FACTORIES) as [SlotSourceId, SlotFactory][]) {
			const slot = factory(detached, symbolName);
			this._slotInstances.set(sourceId, slot);
			this._sessionDisposables.add(slot);
		}

		// Slack mentions — created explicitly so service callbacks can be wired.
		const slackSlot = new SlackMentionsSlot(detached, {
			onConnectClicked: () => this._connectSlack(),
			onDisconnectClicked: () => this._disconnectSlack(),
			onChannelTagClicked: () => this._openChannelPicker(),
			onChannelClearClicked: () => this._clearSlackChannel(),
			onMessageClicked: permalink => {
				this._openerService.open(URI.parse(permalink), { openExternal: true });
			},
		});
		this._slotInstances.set('contextBubble.slackMentions', slackSlot);
		this._sessionDisposables.add(slackSlot);

		// Position slots according to saved config
		this._applyLayout(bubble, config);

		// Wire call-graph interactions from the slot.
		this._callNodeLocations.clear();
		if (callGraphSlot) {
			this._sessionDisposables.add(
				callGraphSlot.onNodeCmdClick(name => this._navigateToNode(name))
			);
			this._sessionDisposables.add(
				callGraphSlot.onBackBtnClicked(() => this._historyBack())
			);
			this._sessionDisposables.add(
				callGraphSlot.onForwardBtnClicked(() => this._historyForward())
			);
		}

		// Git history — real SCM data
		this._fetchGitHistory();

		// Slack — check for stored token and fetch or show not-configured state
		this._initSlackSlot();

		// Call graph — real LSP data via CallHierarchyModel
		this._fetchCallGraph();
	}

	// -------------------------------------------------------------------------
	// Call graph — dispatch by symbol type
	// -------------------------------------------------------------------------

	/**
	 * Entry point called whenever call graph data needs to be (re-)fetched.
	 * Dispatches to the appropriate strategy based on the current symbol type:
	 * - function → CallHierarchyProvider (with Reference + text fallbacks)
	 * - class    → LinkProvider (outgoing imports) + ReferenceProvider (incoming importers)
	 */
	private _fetchCallGraph(): void {
		if (this._currentSymbolType === 'class') {
			this._fetchDependencyGraph();
		} else {
			this._fetchFunctionCallGraph();
		}
	}

	// -------------------------------------------------------------------------
	// Function call graph — LSP fetch (unchanged from original implementation)
	// -------------------------------------------------------------------------

	private _fetchFunctionCallGraph(): void {
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

					// Filter out-edges to project-local functions only.
					// Callees whose URI does not fall under a workspace folder
					// (e.g. node_modules, stdlib .d.ts files) are excluded.
					const localOutgoing = outgoing.filter(c => this._isLocalUri(c.to.uri));

					// Store precise locations for cmd-click navigation
					for (const c of incoming) {
						this._callNodeLocations.set(c.from.name, { uri: c.from.uri, selectionRange: c.from.selectionRange });
					}
					for (const c of localOutgoing) {
						this._callNodeLocations.set(c.to.name, { uri: c.to.uri, selectionRange: c.to.selectionRange });
					}
					slot.renderContent({
						callers: incoming.map(c => c.from.name),
						callees: localOutgoing.map(c => c.to.name),
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
				const result = _fetchCallGraphViaText(model, symbolName, position.lineNumber);
				slot.renderContent(result);
				// Populate location cache so cmd-click can navigate
				for (const callerName of result.callers) {
					if (!this._callNodeLocations.has(callerName)) {
						const ln = _findDeclarationLine(model, callerName);
						if (ln !== undefined) {
							const col = model.getLineContent(ln).indexOf(callerName) + 1;
							this._callNodeLocations.set(callerName, {
								uri: model.uri,
								selectionRange: { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col + callerName.length },
							});
						}
					}
				}
				for (const calleeName of result.callees) {
					if (!this._callNodeLocations.has(calleeName)) {
						const ln = _findDeclarationLine(model, calleeName);
						if (ln !== undefined) {
							const col = model.getLineContent(ln).indexOf(calleeName) + 1;
							this._callNodeLocations.set(calleeName, {
								uri: model.uri,
								selectionRange: { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col + calleeName.length },
							});
						}
					}
				}
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

	// -------------------------------------------------------------------------
	// Dependency graph — class mode fetch
	// -------------------------------------------------------------------------

	/**
	 * Builds the dependency graph for a class symbol.
	 *
	 * **Outgoing** (what this class imports):
	 *   Uses `LinkProvider`, which resolves import path strings to absolute file
	 *   URIs. Filtered to project-local URIs via `_isLocalUri`. The imported
	 *   identifier name is extracted from the import line text and used as the
	 *   node label; the URI basename is used as a fallback.
	 *
	 *   If no LinkProvider is registered (e.g. TypeScript server not active),
	 *   outgoing deps are empty — documented here, no error state raised.
	 *
	 * **Incoming** (who imports this class):
	 *   Uses `ReferenceProvider` at the class declaration position. All cross-file
	 *   references whose containing line matches `/\bimport\b/` are treated as
	 *   import sites (files that import this class). Filtered to project-local URIs.
	 *
	 *   If no ReferenceProvider is registered, incoming deps are empty — same
	 *   graceful degradation as outgoing.
	 *
	 * The graph visual language is identical to function mode: centre node,
	 * directed edges, in/out layout, same node and edge styling. The data
	 * semantics change; the rendering does not.
	 */
	private _fetchDependencyGraph(): void {
		const model = this._currentModel;
		const position = this._currentPosition;
		const slot = this._slotInstances.get('contextBubble.callGraph');
		if (!slot || !model || !position) {
			slot?.renderContent({ callers: [], callees: [] });
			return;
		}

		const cts = new CancellationTokenSource();
		this._sessionDisposables.add({ dispose: () => cts.dispose(true) });

		const doFetch = async () => {
			// ---- OUTGOING: what does this class import? -------------------------
			// The built-in link provider only detects URL literals (http://, file://)
			// and does NOT resolve TypeScript module specifiers. Scan import lines
			// directly from the model text instead — reliable in all LSP modes.
			// Only relative paths (./  ../) are collected; bare specifiers like
			// 'react' or '@company/pkg' are node_modules and excluded by design.
			const IMPORT_SCAN_LINES = 100;
			const outgoingNames: string[] = [];
			// Matches the module path in:  from './x'  |  from "../x"  |  require('./x')
			const relImportRe = /(?:from|require\s*\()\s*['"](\.[^'"]+)['"]/;

			for (let ln = 1; ln <= Math.min(model.getLineCount(), IMPORT_SCAN_LINES); ln++) {
				if (cts.token.isCancellationRequested) { return; }
				const lineText = model.getLineContent(ln);
				const pathMatch = relImportRe.exec(lineText);
				if (!pathMatch) { continue; }

				const relPath = pathMatch[1];

				// Resolve the relative path to an absolute URI.
				// URI.joinPath uses posix.join semantics, so '..' is normalised correctly.
				//
				// IMPORTANT: Code OSS (TypeScript ESM style) writes `import './foo.js'`
				// while the actual file on disk is `foo.ts`. We must NEVER pass the stated
				// extension directly — always build a candidate list, prefer .ts over .js,
				// and confirm existence before using the URI.
				const hasExtension = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(relPath);
				const base = URI.joinPath(model.uri, '..', relPath);
				const candidates: URI[] = [];
				if (hasExtension) {
					// Prefer the TypeScript source over any stated .js/.jsx extension.
					const tsPath = base.path.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx');
					if (tsPath !== base.path) {
						candidates.push(base.with({ path: tsPath })); // .ts/.tsx first
					}
					candidates.push(base); // stated extension as fallback
				} else {
					// No extension — try common TypeScript/JavaScript suffixes, then index files.
					candidates.push(
						base.with({ path: base.path + '.ts' }),
						base.with({ path: base.path + '.tsx' }),
						base.with({ path: base.path + '.js' }),
						base.with({ path: base.path + '.jsx' }),
						URI.joinPath(base, 'index.ts'),
						URI.joinPath(base, 'index.tsx'),
					);
				}
				// 1. Check already-loaded models first (free, synchronous).
				// 2. Fall back to parallel IFileService.exists() checks.
				let resolvedUri: URI | undefined;
				for (const cand of candidates) {
					if (this._modelService.getModel(cand)) {
						resolvedUri = cand;
						break;
					}
				}
				if (!resolvedUri) {
					const existsResults = await Promise.all(
						candidates.map(c => this._fileService.exists(c).catch(() => false))
					);
					const idx = existsResults.findIndex(Boolean);
					resolvedUri = idx >= 0 ? candidates[idx] : undefined;
				}
				// Skip if we couldn't resolve a real file path
				if (!resolvedUri) { continue; }

				if (!this._isLocalUri(resolvedUri)) {
					continue;
				}

				const name = _extractImportedName(lineText, resolvedUri);
				if (!outgoingNames.includes(name)) {
					outgoingNames.push(name);
				}

				// Store location for cmd-click. Prefer a class declaration position
				// in the linked file if the model is already loaded; fall back to
				// top-of-file so the editor at least opens at the right document.
				if (!this._callNodeLocations.has(name)) {
					let selectionRange: IRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
					const linkedModel = this._modelService.getModel(resolvedUri);
					if (linkedModel) {
						const [symProvider] = this._languageFeaturesService.documentSymbolProvider.ordered(linkedModel);
						if (symProvider) {
							const linkedSymbols = await symProvider.provideDocumentSymbols(linkedModel, cts.token) ?? [];
							if (!cts.token.isCancellationRequested) {
								const found =
									linkedSymbols.find(s => s.name === name && (s.kind === SymbolKind.Class || s.kind === SymbolKind.Interface)) ??
									linkedSymbols.find(s => s.kind === SymbolKind.Class || s.kind === SymbolKind.Interface);
								if (found) {
									selectionRange = found.selectionRange;
								}
							}
						}
					}
					this._callNodeLocations.set(name, { uri: resolvedUri, selectionRange });
				}
			}

			if (cts.token.isCancellationRequested) {
				return;
			}

			// ---- INCOMING: who imports this class? ------------------------------
			const incomingNames: string[] = [];
			const [refProvider] = this._languageFeaturesService.referenceProvider.ordered(model);
			if (refProvider) {
				const pos = new Position(position.lineNumber, position.column);
				const refs = await refProvider.provideReferences(
					model, pos, { includeDeclaration: false }, cts.token
				) ?? [];

				if (!cts.token.isCancellationRequested) {
					for (const ref of refs) {
						if (!this._isLocalUri(ref.uri)) {
							continue;
						}

						// Determine whether this reference is on an import line.
						// Prefer reading from an already-loaded model; fall back to
						// treating the reference as an import (conservative).
						const refModel = ref.uri.toString() === model.uri.toString()
							? model
							: this._modelService.getModel(ref.uri);

						let isImport: boolean;
						if (refModel) {
							const lineText = refModel.getLineContent(ref.range.startLineNumber);
							isImport = /\bimport\b/.test(lineText);
						} else {
							// Model not loaded — conservatively include as an importer.
							isImport = true;
						}

						if (!isImport) {
							continue;
						}

						// Use the importing file's basename as the node label.
						// A more precise class name could be found via documentSymbolProvider
						// on the importing file, but that requires the model to be loaded;
						// the basename is always available and clearly identifies the module.
						const name = _fileBasename(ref.uri);
						if (!incomingNames.includes(name)) {
							incomingNames.push(name);
							if (!this._callNodeLocations.has(name)) {
								this._callNodeLocations.set(name, {
									uri: ref.uri,
									selectionRange: {
										startLineNumber: ref.range.startLineNumber,
										startColumn: ref.range.startColumn,
										endLineNumber: ref.range.startLineNumber,
										endColumn: ref.range.endColumn,
									},
								});
							}
						}
					}
				}
			}
			// else: no reference provider registered — incoming deps will be empty (graceful degradation)

			slot.renderContent({ callers: incomingNames, callees: outgoingNames });
		};

		doFetch().catch(() => {
			if (!cts.token.isCancellationRequested) {
				slot.setState('error');
			}
		});
	}

	// -------------------------------------------------------------------------
	// Git history — SCM fetch
	// -------------------------------------------------------------------------

	private _fetchGitHistory(): void {
		const slot = this._slotInstances.get('contextBubble.gitHistory') as GitHistorySlot | undefined;
		const model = this._currentModel;
		if (!slot || !model) {
			slot?.setState('error');
			return;
		}

		const fileUri = model.uri;
		const repository = this._scmService.getRepository(fileUri);
		if (!repository) {
			slot.renderContent([]);
			return;
		}

		const historyProvider = repository.provider.historyProvider.get();
		if (!historyProvider) {
			slot.renderContent([]);
			return;
		}

		const cts = new CancellationTokenSource();
		this._sessionDisposables.add({ dispose: () => cts.dispose(true) });

		const doFetch = async () => {
			// Resolve the current HEAD ref so the provider knows which branch to query
			const currentRef = historyProvider.historyItemRef.get();
			const historyItemRefs = currentRef ? [currentRef.id] : undefined;

			// Pass 1: fetch up to 30 recent commits on this branch
			const items = await historyProvider.provideHistoryItems({ limit: 30, historyItemRefs }, cts.token);
			if (cts.token.isCancellationRequested) { return; }
			if (!items || items.length === 0) { slot.renderContent([]); return; }

			const fileFsPath = fileUri.fsPath;
			const relevant: CommitEntry[] = [];

			// Pass 2: filter to commits that touched this file
			// Note: change URIs include a ?ref=<hash> query string, so compare fsPath not toString()
			for (const item of items) {
				if (cts.token.isCancellationRequested) { return; }
				if (relevant.length >= 10) { break; }

				const parentId = item.parentIds.length > 0 ? item.parentIds[0] : undefined;
				const changes = await historyProvider.provideHistoryItemChanges(
					item.id, parentId, cts.token
				);
				if (cts.token.isCancellationRequested) { return; }

				const touchesFile = changes?.some(c => c.uri.fsPath === fileFsPath) ?? false;
				if (touchesFile) {
					relevant.push({
						hash: item.displayId ?? item.id.slice(0, 7),
						author: item.author ?? '',
						relativeTime: _formatRelativeTime(item.timestamp),
						message: item.subject,
					});
				}
			}

			slot.renderContent(relevant);
		};

		doFetch().catch(() => {
			if (!cts.token.isCancellationRequested) {
				slot.setState('error');
			}
		});
	}

	// -------------------------------------------------------------------------
	// Slack mentions — auth and live API fetch
	// -------------------------------------------------------------------------

	/**
	 * Called once per session when slots are created. Reads the stored token and
	 * either shows the not-configured state or kicks off a live fetch.
	 */
	private _initSlackSlot(): void {
		const slackSlot = this._slotInstances.get('contextBubble.slackMentions') as SlackMentionsSlot | undefined;
		if (!slackSlot) {
			return;
		}

		Promise.resolve(this._storageService.get('contextBubble.slackToken', StorageScope.APPLICATION)).then(token => {
			if (!token) {
				slackSlot.renderNotConfigured();
				return;
			}
			this._slackToken = token;
			const channel = this._configurationService.getValue<string>('contextBubble.slackChannel') || undefined;
			slackSlot.setConnectedState(true, channel);
			this._fetchSlackMentions();
		}, () => {
			slackSlot.renderNotConfigured();
		});
	}

	/**
	 * Opens a native InputBox prompting for a Slack user token (xoxp-...).
	 * On confirm, stores the token in secret storage and triggers a fetch.
	 * On cancel, the slot remains in not-configured state.
	 */
	private _connectSlack(): void {
		const slackSlot = this._slotInstances.get('contextBubble.slackMentions') as SlackMentionsSlot | undefined;
		if (!slackSlot) {
			return;
		}

		const inputBox = this._quickInputService.createInputBox();
		inputBox.title = nls.localize('slack.connect.title', 'Connect Slack');
		inputBox.placeholder = nls.localize('slack.connect.placeholder', 'Paste your Slack user token (xoxp-...)');
		inputBox.password = true;

		const disposables = new DisposableStore();
		disposables.add(inputBox);

		disposables.add(inputBox.onDidAccept(() => {
			const token = inputBox.value.trim();
			inputBox.hide();
			disposables.dispose();

			if (!token) {
				return;
			}

			this._storageService.store('contextBubble.slackToken', token, StorageScope.APPLICATION, StorageTarget.MACHINE);
			Promise.resolve().then(() => {
				this._slackToken = token;
				const channel = this._configurationService.getValue<string>('contextBubble.slackChannel') || undefined;
				slackSlot.setConnectedState(true, channel);
				slackSlot.setState('loading');
				this._fetchSlackMentions();
			}, () => {
				slackSlot.renderNotConfigured();
			});
		}));

		disposables.add(inputBox.onDidHide(() => {
			disposables.dispose();
		}));

		inputBox.show();
	}

	/**
	 * Calls `auth.test` with the stored token and surfaces the result as a
	 * notification — useful for diagnosing token / permission problems without
	 * needing a bubble open.
	 */
	private _testSlackConnection(): void {
		const token = this._storageService.get('contextBubble.slackToken', StorageScope.APPLICATION);
		if (!token) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: nls.localize('slack.test.noToken', 'No Slack token stored. Use "Connect Slack" inside the bubble first.'),
			});
			return;
		}

		const cts = new CancellationTokenSource();
		this._nativeHostService.fetchUrl(
			'https://slack.com/api/auth.test',
			{ 'Authorization': `Bearer ${token}` },
		).then(({ statusCode, body }) => {
			cts.dispose();
			let parsed: { ok: boolean; error?: string; user?: string; team?: string } | undefined;
			try {
				parsed = JSON.parse(body);
			} catch {
				// fall through — raw body shown below
			}
			if (parsed?.ok) {
				this._notificationService.notify({
					severity: Severity.Info,
					message: nls.localize('slack.test.ok', 'Slack token valid — user: {0}, workspace: {1}', parsed.user ?? '?', parsed.team ?? '?'),
				});
			} else {
				this._notificationService.notify({
					severity: Severity.Error,
					message: nls.localize('slack.test.fail', 'Slack auth.test failed (HTTP {0}): {1}', String(statusCode), parsed?.error ?? body.slice(0, 200)),
				});
			}
		}, (err: Error) => {
			cts.dispose();
			this._notificationService.notify({
				severity: Severity.Error,
				message: nls.localize('slack.test.networkError', 'Slack auth.test network error: {0}', err.message),
			});
		});
	}

	/**
	 * Removes the stored token, resets in-memory state, and returns the slot
	 * to not-configured state.
	 */
	private _disconnectSlack(): void {
		const slackSlot = this._slotInstances.get('contextBubble.slackMentions') as SlackMentionsSlot | undefined;
		this._slackToken = undefined;
		this._slackChannels = [];
		this._storageService.remove('contextBubble.slackToken', StorageScope.APPLICATION);
		slackSlot?.renderNotConfigured();
	}

	/**
	 * Opens a QuickPick populated from the cached channel list so the user can
	 * scope Slack search to a single channel. Selecting a channel writes
	 * contextBubble.slackChannel to workspace settings and re-fetches.
	 */
	private _openChannelPicker(): void {
		const slackSlot = this._slotInstances.get('contextBubble.slackMentions') as SlackMentionsSlot | undefined;
		if (!slackSlot) {
			return;
		}

		const quickPick = this._quickInputService.createQuickPick<IQuickPickItem>();
		quickPick.title = nls.localize('slack.channelPicker.title', 'Filter by Slack Channel');
		quickPick.placeholder = nls.localize('slack.channelPicker.placeholder', 'Type to filter channels...');
		quickPick.items = this._slackChannels.map(c => ({ label: `#${c.name}`, description: c.id }));

		const currentChannel = this._configurationService.getValue<string>('contextBubble.slackChannel') || undefined;
		if (currentChannel) {
			const active = quickPick.items.find(i => i.label === `#${currentChannel}`);
			if (active) {
				quickPick.activeItems = [active];
			}
		}

		const disposables = new DisposableStore();
		disposables.add(quickPick);

		disposables.add(quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			quickPick.hide();
			disposables.dispose();

			if (!selected) {
				return;
			}

			const channelName = selected.label.replace(/^#/, '');
			this._configurationService.updateValue(
				'contextBubble.slackChannel', channelName, ConfigurationTarget.WORKSPACE
			).then(() => {
				slackSlot.setConnectedState(true, channelName);
				slackSlot.setState('loading');
				this._fetchSlackMentions();
			}, () => { /* ignore write errors */ });
		}));

		disposables.add(quickPick.onDidHide(() => {
			disposables.dispose();
		}));

		quickPick.show();
	}

	/**
	 * Clears the active channel filter, writes `undefined` to workspace settings,
	 * updates slot header, and re-fetches against the whole workspace.
	 */
	private _clearSlackChannel(): void {
		const slackSlot = this._slotInstances.get('contextBubble.slackMentions') as SlackMentionsSlot | undefined;
		this._configurationService.updateValue(
			'contextBubble.slackChannel', undefined, ConfigurationTarget.WORKSPACE
		).then(() => {
			slackSlot?.setConnectedState(true, undefined);
			slackSlot?.setState('loading');
			this._fetchSlackMentions();
		}, () => { /* ignore write errors */ });
	}

	/**
	 * Fetches https://slack.com/api/search.messages for the current symbol name,
	 * optionally scoped to a channel from workspace settings.
	 *
	 * Proxied through IRequestService (main process IPC) — never calls fetch()
	 * directly from the renderer.
	 */
	private _fetchSlackMentions(): void {
		const slackSlot = this._slotInstances.get('contextBubble.slackMentions') as SlackMentionsSlot | undefined;
		const token = this._slackToken;
		if (!slackSlot || !token) {
			return;
		}

		const symbolName = this._currentSymbolName;
		const channel = this._configurationService.getValue<string>('contextBubble.slackChannel') || undefined;
		const showChannelBadge = !channel;

		const cts = new CancellationTokenSource();
		this._sessionDisposables.add({ dispose: () => cts.dispose(true) });

		const doFetch = async () => {
			// Guard: nothing meaningful to search for without a symbol.
			if (!symbolName) {
				slackSlot.renderContent([]);
				return;
			}

			// Fetch channel list once on the first whole-workspace search so the
			// channel picker has items immediately.  This is best-effort — a failure
			// here must not abort the actual search.
			if (!channel && this._slackChannels.length === 0) {
				try {
					await this._fetchSlackChannels(token, cts.token);
				} catch {
					// channel list is a convenience; continue without it
				}
				if (cts.token.isCancellationRequested) {
					return;
				}
			}

			const query = encodeURIComponent(symbolName);
			const channelParam = channel ? `&channel=${encodeURIComponent(channel)}` : '';
			const url = `https://slack.com/api/search.messages?query=${query}&count=10${channelParam}`;

			const { statusCode, body: text } = await this._nativeHostService.fetchUrl(
				url,
				{ 'Authorization': `Bearer ${token}` },
			);

			if (cts.token.isCancellationRequested) {
				return;
			}

			console.log('[contextBubble] search.messages status:', statusCode);
			console.log('[contextBubble] search.messages body:', text.slice(0, 300));

			if (!text) {
				slackSlot.setState('error');
				return;
			}

			const data = JSON.parse(text) as {
				ok: boolean;
				error?: string;
				messages?: {
					matches?: {
						username?: string;
						user?: string;
						ts?: string;
						text?: string;
						channel?: { name?: string };
						permalink?: string;
					}[];
				};
			};

			if (!data.ok) {
				console.warn('[contextBubble] Slack API error:', data.error);
				// If Slack says the auth is bad, revert to not-configured state so
				// the user can re-enter a valid token.
				if (data.error === 'invalid_auth' || data.error === 'token_revoked' || data.error === 'account_inactive') {
					this._slackToken = undefined;
					this._storageService.remove('contextBubble.slackToken', StorageScope.APPLICATION);
					slackSlot.setConnectedState(false);
					slackSlot.renderNotConfigured();
				} else {
					slackSlot.setState('error');
				}
				return;
			}

			const matches = data.messages?.matches ?? [];
			const messages: SlackMessage[] = matches.map(m => ({
				username: m.username ?? m.user ?? 'unknown',
				content: m.text ?? '',
				relativeTime: _formatRelativeTime(Math.floor(parseFloat(m.ts ?? '0') * 1000)),
				channelName: showChannelBadge ? (m.channel?.name ?? undefined) : undefined,
				permalink: m.permalink ?? '',
			}));

			slackSlot.renderContent(messages);
		};

		doFetch().catch((err) => {
			console.error('[contextBubble] doFetch threw:', err);
			if (!cts.token.isCancellationRequested) {
				slackSlot.setState('error');
			}
		});
	}

	/**
	 * Fetches the workspace channel list via conversations.list and caches it in
	 * `_slackChannels`. Called at most once per session (before first whole-workspace
	 * search). The cached list is used by the channel picker without re-fetching.
	 */
	private async _fetchSlackChannels(token: string, _cancellationToken: CancellationToken): Promise<void> {
		const { body: text } = await this._nativeHostService.fetchUrl(
			'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true',
			{ 'Authorization': `Bearer ${token}` },
		);

		if (!text) {
			return;
		}

		const data = JSON.parse(text) as {
			ok: boolean;
			channels?: { id: string; name: string }[];
		};

		if (data.ok && Array.isArray(data.channels)) {
			this._slackChannels = data.channels.map(c => ({ id: c.id, name: c.name }));
		}
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
							const sym = _findContainingFunction(symbols, range);
							if (sym) {
								callerNames.add(sym.name);
								// Store location for cmd-click navigation
								this._callNodeLocations.set(sym.name, {
									uri: fileModel.uri,
									selectionRange: sym.selectionRange,
								});
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
	// Workspace URI filter — reused by both call graph and dependency graph
	// -------------------------------------------------------------------------

	/**
	 * Returns true when `uri` falls under a workspace folder and is not a
	 * type-declaration (.d.ts) or node_modules file. Used to exclude external
	 * library symbols and type stubs from both function callees and class deps.
	 */
	private _isLocalUri(uri: URI): boolean {
		const uriPath = uri.path;
		if (uriPath.includes('/node_modules/') || uriPath.endsWith('.d.ts')) {
			return false;
		}
		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return true; // no workspace configured — accept everything
		}
		const uriStr = uri.toString();
		return workspaceFolders.some(f => {
			const root = f.uri.toString();
			const rootWithSlash = root.endsWith('/') ? root : root + '/';
			return uriStr.startsWith(rootWithSlash) || uriStr === root;
		});
	}

	// -------------------------------------------------------------------------
	// Session teardown (only called on ×)
	// -------------------------------------------------------------------------

	private _teardownSession(): void {
		this._sessionDisposables.clear();
		this._slotInstances.clear();
		this._callNodeLocations.clear();
		this._navBackStack = [];
		this._navForwardStack = [];
		this._slackToken = undefined;
		this._slackChannels = [];
		this._anchoredEditor = undefined;
		this._currentSymbolName = '';
		this._currentSymbolType = 'function';
		this._currentModel = null;
		this._currentPosition = null;
		this._anchorSlot.value = undefined;
		this._arrowSlot.value = undefined;
		this._bubbleSlot.value = undefined;
	}

	private async _navigateToNode(name: string): Promise<void> {
		const callGraphSlot = this._slotInstances.get('contextBubble.callGraph') as CallGraphSlot | undefined;

		// Snapshot current state onto the back stack before changing anything so the
		// saved entry reflects the symbol we're navigating AWAY from.
		const currentData = callGraphSlot?.getLastRenderedData();
		if (currentData && this._currentModel && this._currentPosition) {
			this._navBackStack.push({
				symbolName: this._currentSymbolName,
				data: currentData,
				uri: this._currentModel.uri.toString(),
				lineNumber: this._currentPosition.lineNumber,
				column: this._currentPosition.column,
			});
			this._navForwardStack = [];
			// Show the history bar immediately — the slot will re-render shortly.
			callGraphSlot?.updateHistoryBar(true, false);
		}

		const loc = this._callNodeLocations.get(name);

		// Update the centre symbol in the slot immediately so that the next
		// renderContent() call uses the correct label.
		this._currentSymbolName = name;
		callGraphSlot?.updateSymbol(name);

		// Best-effort model / position update before the async open completes.
		// Will be refined after openEditor resolves in class mode.
		if (loc) {
			const existingModel = this._modelService.getModel(loc.uri);
			if (existingModel) {
				this._currentModel = existingModel;
			}
			this._currentPosition = {
				lineNumber: loc.selectionRange.startLineNumber,
				column: loc.selectionRange.startColumn,
			};
		} else {
			// Fallback — scan the current file for a declaration of the symbol.
			const model = this._currentModel;
			if (model) {
				const ln = _findDeclarationLine(model, name);
				if (ln !== undefined) {
					this._currentPosition = {
						lineNumber: ln,
						column: Math.max(1, model.getLineContent(ln).indexOf(name) + 1),
					};
				}
			}
		}

		// Clear the location cache — it belongs to the previous symbol.
		this._callNodeLocations.clear();

		// Open the editor at the target symbol's location.  Awaiting ensures the
		// model is loaded before we fetch data — critical for class mode where the
		// target file may not have been open previously.
		if (loc) {
			try {
				await this._editorService.openEditor({
					resource: loc.uri,
					options: { selection: loc.selectionRange, revealIfOpened: true },
				});
			} catch {
				// Ignore open errors — fetch will degrade gracefully without a model.
			}

			// After the editor is open the model should now be available.
			const openedModel = this._modelService.getModel(loc.uri);
			if (openedModel) {
				this._currentModel = openedModel;
			}

			// For class mode: the stored location may point to the import line of
			// an incoming dep or top-of-file for an outgoing dep. Run a quick
			// DocumentSymbolProvider pass to find the actual class declaration in
			// the opened file so that _fetchDependencyGraph receives an accurate
			// position and _currentSymbolName matches the class name in that file.
			if (this._currentSymbolType === 'class' && openedModel) {
				const cts = new CancellationTokenSource();
				try {
					const [symProvider] = this._languageFeaturesService.documentSymbolProvider.ordered(openedModel);
					if (symProvider) {
						const syms = await symProvider.provideDocumentSymbols(openedModel, cts.token) ?? [];
						if (!cts.token.isCancellationRequested) {
							// Prefer a class/interface whose name matches the navigated node;
							// fall back to the first class/interface in the file.
							const exact = syms.find(s =>
								s.name === name &&
								(s.kind === SymbolKind.Class || s.kind === SymbolKind.Interface)
							);
							const first = syms.find(s =>
								s.kind === SymbolKind.Class || s.kind === SymbolKind.Interface
							);
							const found = exact ?? first;
							if (found) {
								this._currentSymbolName = found.name;
								callGraphSlot?.updateSymbol(found.name);
								this._currentPosition = {
									lineNumber: found.selectionRange.startLineNumber,
									column: found.selectionRange.startColumn,
								};
							}
						}
					}
				} finally {
					cts.dispose(true);
				}
			}
		} else {
			const model = this._currentModel;
			const editor = this._anchoredEditor;
			if (model && editor && this._currentPosition) {
				editor.revealLineInCenter(this._currentPosition.lineNumber);
				editor.setPosition(this._currentPosition);
			}
		}

		// Re-trigger the full bubble data load for the new symbol.
		this._fetchCallGraph();
		this._fetchGitHistory();
		this._fetchSlackMentions();
	}

	// -------------------------------------------------------------------------
	// History navigation — back / forward
	// -------------------------------------------------------------------------

	/**
	 * Restores the previous symbol in the navigation history.
	 * Mirrors what _navigateToNode does for cmd-click but in reverse:
	 * re-renders the call graph from cached data, navigates the editor back to
	 * the previous symbol's location, and re-fetches git history + Slack.
	 */
	private async _historyBack(): Promise<void> {
		if (this._navBackStack.length === 0) {
			return;
		}

		const callGraphSlot = this._slotInstances.get('contextBubble.callGraph') as CallGraphSlot | undefined;

		// Save current state onto the forward stack so the user can go forward again.
		const currentData = callGraphSlot?.getLastRenderedData();
		this._navForwardStack.push({
			symbolName: this._currentSymbolName,
			data: currentData ?? { callers: [], callees: [] },
			uri: this._currentModel?.uri.toString() ?? '',
			lineNumber: this._currentPosition?.lineNumber ?? 1,
			column: this._currentPosition?.column ?? 1,
		});

		// Pop and restore the previous state.
		const entry = this._navBackStack.pop()!;
		this._currentSymbolName = entry.symbolName;
		callGraphSlot?.updateSymbol(entry.symbolName);
		this._currentPosition = { lineNumber: entry.lineNumber, column: entry.column };

		const targetUri = URI.parse(entry.uri);
		const existingModel = this._modelService.getModel(targetUri);
		if (existingModel) {
			this._currentModel = existingModel;
		}

		// Re-render call graph from cached data — no LSP fetch needed.
		callGraphSlot?.renderContent(entry.data);
		callGraphSlot?.updateHistoryBar(
			this._navBackStack.length > 0,
			this._navForwardStack.length > 0,
		);

		// Navigate the editor to the restored symbol's location.
		try {
			await this._editorService.openEditor({
				resource: targetUri,
				options: {
					selection: {
						startLineNumber: entry.lineNumber,
						startColumn: entry.column,
						endLineNumber: entry.lineNumber,
						endColumn: entry.column,
					},
					revealIfOpened: true,
				},
			});
			const openedModel = this._modelService.getModel(targetUri);
			if (openedModel) {
				this._currentModel = openedModel;
			}
		} catch {
			// Ignore navigation errors — git/Slack re-fetch will still work.
		}

		// Re-fetch the two data-dependent slots for the restored symbol.
		this._fetchGitHistory();
		this._fetchSlackMentions();
	}

	/**
	 * Advances to the next symbol in the navigation history (undoes a back step).
	 * Symmetric to _historyBack.
	 */
	private async _historyForward(): Promise<void> {
		if (this._navForwardStack.length === 0) {
			return;
		}

		const callGraphSlot = this._slotInstances.get('contextBubble.callGraph') as CallGraphSlot | undefined;

		// Save current state onto the back stack.
		const currentData = callGraphSlot?.getLastRenderedData();
		this._navBackStack.push({
			symbolName: this._currentSymbolName,
			data: currentData ?? { callers: [], callees: [] },
			uri: this._currentModel?.uri.toString() ?? '',
			lineNumber: this._currentPosition?.lineNumber ?? 1,
			column: this._currentPosition?.column ?? 1,
		});

		// Pop and restore the forward state.
		const entry = this._navForwardStack.pop()!;
		this._currentSymbolName = entry.symbolName;
		callGraphSlot?.updateSymbol(entry.symbolName);
		this._currentPosition = { lineNumber: entry.lineNumber, column: entry.column };

		const targetUri = URI.parse(entry.uri);
		const existingModel = this._modelService.getModel(targetUri);
		if (existingModel) {
			this._currentModel = existingModel;
		}

		// Re-render call graph from cached data — no LSP fetch needed.
		callGraphSlot?.renderContent(entry.data);
		callGraphSlot?.updateHistoryBar(
			this._navBackStack.length > 0,
			this._navForwardStack.length > 0,
		);

		// Navigate the editor to the restored symbol's location.
		try {
			await this._editorService.openEditor({
				resource: targetUri,
				options: {
					selection: {
						startLineNumber: entry.lineNumber,
						startColumn: entry.column,
						endLineNumber: entry.lineNumber,
						endColumn: entry.column,
					},
					revealIfOpened: true,
				},
			});
			const openedModel = this._modelService.getModel(targetUri);
			if (openedModel) {
				this._currentModel = openedModel;
			}
		} catch {
			// Ignore navigation errors.
		}

		// Re-fetch the two data-dependent slots for the restored symbol.
		this._fetchGitHistory();
		this._fetchSlackMentions();
	}

	// -------------------------------------------------------------------------
	// Coordinate resolution
	// -------------------------------------------------------------------------

	private _resolveEditorContext(): {
		editor: ICodeEditor;
		lineNumber: number;
		selectionRange: IRange;
		symbolName: string;
		model: ITextModel | null;
		position: IPosition;
		/** Fast regex-based type hint — overridden by the async LSP check later. */
		symbolTypeHint: 'function' | 'class';
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

		// Symbol name and LSP position are extracted from the top of the selection
		// (startLineNumber) since that is where the declaration lives.
		const model = editor.getModel();
		const { symbolName, position } = model
			? _resolveSymbolFromSelection(model, selection.startLineNumber, selection.endLineNumber)
			: { symbolName: 'symbol', position: selection.getStartPosition() };

		// Quick regex hint: check whether the declaration line contains `class`.
		// The async DocumentSymbolProvider check in _checkPartialSelectionAndMaybeTrigger
		// will override this with the authoritative LSP kind.
		const firstHeaderLine = model?.getLineContent(selection.startLineNumber) ?? '';
		const symbolTypeHint: 'function' | 'class' = /\bclass\b/.test(firstHeaderLine) ? 'class' : 'function';

		return {
			editor,
			// Anchor is placed at the END of the selection, not the start.
			lineNumber: selection.endLineNumber,
			selectionRange: {
				startLineNumber: selection.startLineNumber,
				startColumn: selection.startColumn,
				endLineNumber: selection.endLineNumber,
				endColumn: selection.endColumn,
			},
			symbolName,
			model,
			position,
			symbolTypeHint,
		};
	}

	// -------------------------------------------------------------------------
	// Dispose
	// -------------------------------------------------------------------------

	override dispose(): void {
		super.dispose();
	}
}
