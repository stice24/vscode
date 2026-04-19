/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { SlotComponent } from './slotComponent.js';
import { mainWindow } from '../../../../base/browser/window.js';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

let _callGraphStylesInjected = false;

function ensureCallGraphStyles(): void {
	if (_callGraphStylesInjected) {
		return;
	}
	_callGraphStylesInjected = true;

	const style = document.createElement('style');
	style.textContent = `

.call-graph-svg {
	display: block;
	width: 100%;
	flex: 1;
	min-height: 0;
}

.call-graph-node {
	cursor: pointer;
}

.call-graph-node circle {
	transition: opacity 0.12s, filter 0.12s;
}

.call-graph-node:hover circle {
	opacity: 0.9;
	filter: brightness(1.45);
}

.call-graph-node text {
	pointer-events: none;
	user-select: none;
}

.call-graph-history-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 5px 10px;
	background: rgba(22, 28, 36, 0.98);
	border-top: 1.5px solid rgba(80, 200, 220, 0.55);
	flex-shrink: 0;
	gap: 8px;
}

.call-graph-history-btn {
	background: none;
	border: 1px solid rgba(80, 200, 220, 0.4);
	cursor: pointer;
	color: rgba(90, 215, 235, 0.97);
	font-size: 13px;
	line-height: 1;
	padding: 2px 8px;
	border-radius: 3px;
	transition: background 0.1s, border-color 0.1s;
	flex-shrink: 0;
}

.call-graph-history-btn:disabled {
	color: rgba(120, 140, 155, 0.4);
	border-color: rgba(120, 140, 155, 0.2);
	cursor: default;
}

.call-graph-history-btn:not(:disabled):hover {
	background: rgba(80, 200, 220, 0.18);
	border-color: rgba(80, 200, 220, 0.6);
}

.call-graph-history-label {
	font-family: monospace, "Courier New";
	font-size: 10px;
	color: rgba(205, 225, 240, 0.97);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex: 1;
	text-align: center;
	letter-spacing: 0.02em;
}

`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data shape for the call graph / dependency slot. */
export interface CallGraphData {
	/**
	 * For function mode: names of functions that call the centre symbol.
	 * For class mode: names of files/classes that import this class (incoming deps).
	 */
	callers: string[];
	/**
	 * For function mode: names of functions the centre symbol calls.
	 * For class mode: names of imported classes/modules this class depends on (outgoing deps).
	 */
	callees: string[];
}


// ---------------------------------------------------------------------------
// Mock data — replace with LSP results in session 5
// ---------------------------------------------------------------------------

export const MOCK_CALL_GRAPH_CALLERS: string[] = ['evalNode', 'runStatement'];
export const MOCK_CALL_GRAPH_CALLEES: string[] = ['tokenize', 'buildAST'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

interface IPoint { x: number; y: number }

/**
 * Returns line start/end coordinates that land on the surface of each circle
 * so arrowheads sit exactly at the circle edge, not inside it.
 */
function edgePoints(
	from: IPoint, fromR: number,
	to: IPoint, toR: number
): { x1: number; y1: number; x2: number; y2: number } {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const d = Math.sqrt(dx * dx + dy * dy);
	if (d === 0) {
		return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
	}
	const ux = dx / d;
	const uy = dy / d;
	return {
		x1: from.x + ux * fromR,
		y1: from.y + uy * fromR,
		x2: to.x - ux * toR,
		y2: to.y - uy * toR,
	};
}

function truncate(name: string, maxLen: number): string {
	return name.length > maxLen ? name.slice(0, maxLen - 1) + '\u2026' : name;
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

/**
 * Slot 1 — Call Graph (function mode) or Dependencies (class mode).
 *
 * Function mode: renders callers on the left, the highlighted function in the
 * centre, callees on the right. Uses CallHierarchyProvider data.
 *
 * Class mode: renders importers (incoming deps) on the left, the highlighted
 * class in the centre, imported classes/modules (outgoing deps) on the right.
 * Uses LinkProvider + ReferenceProvider data.
 *
 * Cmd-click on any node navigates the bubble to that symbol and pushes the
 * current view onto a history stack. A compact history bar appears at the
 * bottom of the slot when history depth > 0, providing back/forward navigation.
 * History navigation preserves the symbol type — a class bubble stays in class
 * mode throughout its navigation chain.
 */
export class CallGraphSlot extends SlotComponent {

	/** Max nodes shown as individual circles on either side before switching to a list widget. */
	private static readonly MAX_SIDE_NODES = 4;

	private readonly _cmdClickEmitter = this._register(new Emitter<string>());
	/** Fired when the user cmd-clicks a node. Payload is the symbol name. */
	readonly onNodeCmdClick = this._cmdClickEmitter.event;

	private _symbolName: string;
	/** Invariant within a session — set at construction, never changes during navigation. */
	private readonly _symbolType: 'function' | 'class';

	// ---- History events — navigation is managed by the controller ----------

	private readonly _backBtnEmitter = this._register(new Emitter<void>());
	/** Fired when the user clicks the ← button in the history bar. */
	readonly onBackBtnClicked = this._backBtnEmitter.event;

	private readonly _fwdBtnEmitter = this._register(new Emitter<void>());
	/** Fired when the user clicks the → button in the history bar. */
	readonly onForwardBtnClicked = this._fwdBtnEmitter.event;

	/** The data from the most recent successful renderContent call. */
	private _lastRenderedData: CallGraphData | null = null;
	/** The history bar DOM element, present only when the controller shows it. */
	private _historyBarEl: HTMLElement | null = null;
	/** Direct reference to the rendered SVG element, avoids querySelector. */
	private _svgEl: SVGSVGElement | null = null;
	/** Currently visible tooltip element, if any. */
	private _activeTooltip: SVGGElement | null = null;

	constructor(container: HTMLElement, symbolName: string, symbolType: 'function' | 'class' = 'function') {
		super(container, symbolType === 'class' ? 'Dependencies' : 'Call Graph');
		this._symbolName = symbolName || 'symbol';
		this._symbolType = symbolType;
		ensureCallGraphStyles();
	}

	// -------------------------------------------------------------------------
	// Public API — called by the controller
	// -------------------------------------------------------------------------

	/**
	 * Updates the symbol name used as the centre node label.
	 * Must be called before renderContent() fires for the new symbol so the
	 * graph renders with the correct label.
	 */
	updateSymbol(name: string): void {
		this._symbolName = name;
	}

	/** Returns the data from the most recent renderContent() call, or null. */
	getLastRenderedData(): CallGraphData | null {
		return this._lastRenderedData;
	}

	/**
	 * Updates the history bar's visibility and button states.
	 * Called by the controller whenever the navigation stack changes.
	 * Passing (false, false) hides the bar entirely.
	 */
	updateHistoryBar(canGoBack: boolean, canGoForward: boolean): void {
		this._historyBarEl?.remove();
		this._historyBarEl = null;

		if (!canGoBack && !canGoForward) {
			return;
		}

		const bar = document.createElement('div');
		bar.className = 'call-graph-history-bar';

		const backBtn = document.createElement('button');
		backBtn.className = 'call-graph-history-btn';
		backBtn.textContent = '\u2190'; // ←
		backBtn.disabled = !canGoBack;
		backBtn.addEventListener('click', () => this._backBtnEmitter.fire());

		const label = document.createElement('span');
		label.className = 'call-graph-history-label';
		label.textContent = this._symbolName;

		const fwdBtn = document.createElement('button');
		fwdBtn.className = 'call-graph-history-btn';
		fwdBtn.textContent = '\u2192'; // →
		fwdBtn.disabled = !canGoForward;
		fwdBtn.addEventListener('click', () => this._fwdBtnEmitter.fire());

		bar.appendChild(backBtn);
		bar.appendChild(label);
		bar.appendChild(fwdBtn);

		this._historyBarEl = bar;
		this.element.appendChild(bar);
	}

	// -------------------------------------------------------------------------
	// SlotComponent override
	// -------------------------------------------------------------------------

	override renderContent(data: unknown): void {
		const { callers, callees } = data as CallGraphData;
		this._lastRenderedData = { callers, callees };

		// Clear any existing graph before rendering fresh content.
		this._clearGraph();

		this.setState('success');
		this._renderGraph(callers, callees);
		// History bar is managed externally by the controller via updateHistoryBar().
	}

	// -------------------------------------------------------------------------
	// Internal graph helpers
	// -------------------------------------------------------------------------

	/** Removes the SVG graph element from the slot DOM and resets tooltip state. */
	private _clearGraph(): void {
		this._activeTooltip = null;
		this._svgEl?.remove();
		this._svgEl = null;
	}

	// -------------------------------------------------------------------------
	// SVG graph construction
	// -------------------------------------------------------------------------

	private _renderGraph(callers: string[], callees: string[]): void {
		const vw = 300;
		const centerR = 22;
		const nodeR = 15;
		const minSpacing = 32; // px between node centres
		const minVH = 120;
		const limit = CallGraphSlot.MAX_SIDE_NODES;

		const useCallerList = callers.length > limit;
		const useCalleeList = callees.length > limit;

		// vh only needs to accommodate the sides that render individual nodes.
		const maxDisplayedNodes = Math.max(
			useCallerList ? 0 : callers.length,
			useCalleeList ? 0 : callees.length,
			1
		);
		const vh = Math.max(minVH, maxDisplayedNodes * minSpacing + nodeR * 6);

		const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
		svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
		svg.classList.add('call-graph-svg');

		// Arrowhead marker — fixed ID is safe because only one bubble exists at a time
		const defs = document.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
		const marker = document.createElementNS(SVG_NS, 'marker') as SVGMarkerElement;
		marker.setAttribute('id', 'ctx-cg-arrow');
		marker.setAttribute('markerWidth', '7');
		marker.setAttribute('markerHeight', '5');
		marker.setAttribute('refX', '6.5');
		marker.setAttribute('refY', '2.5');
		marker.setAttribute('orient', 'auto');
		const arrowPoly = document.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
		arrowPoly.setAttribute('points', '0 0, 7 2.5, 0 5');
		arrowPoly.setAttribute('fill', 'rgba(130, 165, 190, 0.82)');
		marker.appendChild(arrowPoly);
		defs.appendChild(marker);
		svg.appendChild(defs);

		const center: IPoint = { x: vw / 2, y: vh / 2 };
		const callerX = 50;
		const calleeX = vw - 50;

		/** Distribute n nodes evenly in the vertical space, centred on vh/2. */
		const layoutY = (count: number, index: number): number => {
			if (count === 1) {
				return vh / 2;
			}
			const spacing = Math.min(46, (vh - nodeR * 4) / (count - 1));
			const totalSpan = spacing * (count - 1);
			return (vh / 2) - (totalSpan / 2) + index * spacing;
		};

		// Layers — edges first so nodes render on top; tooltip layer always topmost.
		const edgeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		const nodeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		const tooltipLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		svg.appendChild(edgeLayer);
		svg.appendChild(nodeLayer);

		// Callers (function mode) / Importers (class mode)
		if (useCallerList) {
			this._appendListNode(edgeLayer, nodeLayer, callers, { x: callerX, y: vh / 2 }, center, centerR, true, vh);
		} else {
			callers.forEach((name, i) => {
				const pos: IPoint = { x: callerX, y: layoutY(callers.length, i) };
				this._appendEdge(edgeLayer, edgePoints(pos, nodeR, center, centerR));
				this._appendNode(nodeLayer, tooltipLayer, pos, nodeR, name, false);
			});
			if (callers.length === 0) {
				const emptyLabel = this._symbolType === 'class' ? 'no exports' : 'no callers';
				this._appendEmptyLabel(nodeLayer, callerX, vh / 2, emptyLabel);
			}
		}

		// Callees (function mode) / Outgoing imports (class mode)
		if (useCalleeList) {
			this._appendListNode(edgeLayer, nodeLayer, callees, { x: calleeX, y: vh / 2 }, center, centerR, false, vh);
		} else {
			callees.forEach((name, i) => {
				const pos: IPoint = { x: calleeX, y: layoutY(callees.length, i) };
				this._appendEdge(edgeLayer, edgePoints(center, centerR, pos, nodeR));
				this._appendNode(nodeLayer, tooltipLayer, pos, nodeR, name, false);
			});
			if (callees.length === 0) {
				const emptyLabel = this._symbolType === 'class' ? 'no imports' : 'no project callees';
				this._appendEmptyLabel(nodeLayer, calleeX, vh / 2, emptyLabel);
			}
		}

		// Centre node drawn last — sits on top of all edges
		this._appendNode(nodeLayer, tooltipLayer, center, centerR, this._symbolName, true);

		// Tooltip layer is always rendered on top of everything.
		svg.appendChild(tooltipLayer);

		this._svgEl = svg;
		// Insert before the history bar so the bar always stays at the bottom.
		if (this._historyBarEl) {
			this.element.insertBefore(svg, this._historyBarEl);
		} else {
			this.element.appendChild(svg);
		}
	}

	private _appendEmptyLabel(parent: SVGGElement, x: number, y: number, text: string): void {
		const el = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
		el.setAttribute('x', String(x));
		el.setAttribute('y', String(y));
		el.setAttribute('text-anchor', 'middle');
		el.setAttribute('dominant-baseline', 'middle');
		el.setAttribute('fill', 'rgba(120, 140, 155, 0.35)');
		el.setAttribute('font-size', '7');
		el.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
		el.textContent = text;
		parent.appendChild(el);
	}

	private _appendEdge(
		parent: SVGGElement,
		ep: { x1: number; y1: number; x2: number; y2: number }
	): void {
		const line = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
		line.setAttribute('x1', String(Math.round(ep.x1 * 10) / 10));
		line.setAttribute('y1', String(Math.round(ep.y1 * 10) / 10));
		line.setAttribute('x2', String(Math.round(ep.x2 * 10) / 10));
		line.setAttribute('y2', String(Math.round(ep.y2 * 10) / 10));
		line.setAttribute('stroke', 'rgba(130, 165, 190, 0.62)');
		line.setAttribute('stroke-width', '1.1');
		line.setAttribute('marker-end', 'url(#ctx-cg-arrow)');
		parent.appendChild(line);
	}

	private _appendNode(
		parent: SVGGElement,
		tooltipLayer: SVGGElement,
		pos: IPoint,
		r: number,
		name: string,
		isCenter: boolean
	): void {
		const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		g.classList.add('call-graph-node');
		if (isCenter) {
			g.classList.add('call-graph-node--center');
		}

		const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
		circle.setAttribute('cx', String(pos.x));
		circle.setAttribute('cy', String(pos.y));
		circle.setAttribute('r', String(r));
		circle.setAttribute('fill', isCenter ? 'rgba(78, 201, 176, 0.18)' : 'rgba(110, 140, 165, 0.22)');
		circle.setAttribute('stroke', isCenter ? 'rgba(78, 201, 176, 0.88)' : 'rgba(130, 165, 190, 0.72)');
		circle.setAttribute('stroke-width', isCenter ? '1.8' : '1.4');

		const label = truncate(name, isCenter ? 12 : 10);
		const text = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
		text.setAttribute('x', String(pos.x));
		text.setAttribute('font-size', isCenter ? '9' : '8');
		text.setAttribute('font-family', 'monospace, "Courier New"');
		text.setAttribute('text-anchor', 'middle');

		// All labels centred inside their circle
		text.setAttribute('y', String(pos.y));
		text.setAttribute('dominant-baseline', 'middle');
		if (isCenter) {
			text.setAttribute('fill', 'rgba(78, 201, 176, 0.97)');
		} else {
			text.setAttribute('fill', 'rgba(195, 215, 230, 0.92)');
		}
		text.textContent = label;

		g.appendChild(circle);
		g.appendChild(text);

		// Hover tooltip — only needed when the name is truncated.
		if (name !== label) {
			g.addEventListener('mouseenter', () => this._showTooltip(tooltipLayer, pos, r, name));
			g.addEventListener('mouseleave', () => this._hideTooltip());
		}

		g.addEventListener('click', (e: MouseEvent) => {
			if (e.metaKey) {
				this._onNodeCmdClick(name);
			}
		});

		parent.appendChild(g);
	}

	private _showTooltip(layer: SVGGElement, pos: IPoint, r: number, fullName: string): void {
		this._hideTooltip();

		const fontSize = 7.5;
		const padX = 6;
		const padY = 3.5;
		const pillH = fontSize + padY * 2;
		// Rough monospace char width estimate; cap so it stays within the 300px viewBox.
		const pillW = Math.min(fullName.length * 4.6 + padX * 2, 110);
		const pillX = Math.max(4, Math.min(pos.x - pillW / 2, 296 - pillW));
		// Prefer above the node; clamp so it doesn't escape the viewBox top.
		const pillY = Math.max(3, pos.y - r - pillH - 5);

		const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		g.classList.add('call-graph-tooltip');

		const rect = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
		rect.setAttribute('x', String(pillX));
		rect.setAttribute('y', String(pillY));
		rect.setAttribute('width', String(pillW));
		rect.setAttribute('height', String(pillH));
		rect.setAttribute('rx', '4');
		rect.setAttribute('fill', 'rgba(14, 20, 28, 0.97)');
		rect.setAttribute('stroke', 'rgba(78, 201, 176, 0.55)');
		rect.setAttribute('stroke-width', '0.8');

		const text = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
		text.setAttribute('x', String(pillX + pillW / 2));
		text.setAttribute('y', String(pillY + pillH / 2));
		text.setAttribute('text-anchor', 'middle');
		text.setAttribute('dominant-baseline', 'middle');
		text.setAttribute('fill', 'rgba(210, 230, 245, 0.97)');
		text.setAttribute('font-size', String(fontSize));
		text.setAttribute('font-family', 'monospace, "Courier New"');
		text.textContent = fullName;

		g.appendChild(rect);
		g.appendChild(text);
		layer.appendChild(g);
		this._activeTooltip = g;
	}

	private _hideTooltip(): void {
		this._activeTooltip?.remove();
		this._activeTooltip = null;
	}

	/**
	 * Renders a scrollable list widget in place of individual nodes when a side
	 * has more than MAX_SIDE_NODES entries. Draws an edge from the list rect to
	 * the centre node using the same arrow style as individual node edges.
	 */
	private _appendListNode(
		edgeLayer: SVGGElement,
		nodeLayer: SVGGElement,
		names: string[],
		listCenter: IPoint,
		center: IPoint,
		centerR: number,
		isCallers: boolean,
		vh: number
	): void {
		const rectW = 72;
		const rectH = Math.min(84, vh - 16);

		// Edge — treat the rect's half-width as its "radius" so edgePoints lands
		// on the near face of the rectangle rather than inside it.
		const ep = isCallers
			? edgePoints(listCenter, rectW / 2, center, centerR)
			: edgePoints(center, centerR, listCenter, rectW / 2);
		this._appendEdge(edgeLayer, ep);

		// Background rect
		const rx = listCenter.x - rectW / 2;
		const ry = listCenter.y - rectH / 2;

		const rect = document.createElementNS(SVG_NS, 'rect') as SVGRectElement;
		rect.setAttribute('x', String(rx));
		rect.setAttribute('y', String(ry));
		rect.setAttribute('width', String(rectW));
		rect.setAttribute('height', String(rectH));
		rect.setAttribute('rx', '6');
		rect.setAttribute('fill', 'rgba(110, 140, 165, 0.12)');
		rect.setAttribute('stroke', 'rgba(130, 165, 190, 0.65)');
		rect.setAttribute('stroke-width', '1');
		nodeLayer.appendChild(rect);

		// Count label above the rect
		const countLabel = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
		countLabel.setAttribute('x', String(listCenter.x));
		countLabel.setAttribute('y', String(ry - 4));
		countLabel.setAttribute('text-anchor', 'middle');
		countLabel.setAttribute('dominant-baseline', 'auto');
		countLabel.setAttribute('fill', 'rgba(160, 185, 205, 0.7)');
		countLabel.setAttribute('font-size', '6');
		countLabel.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
		const callerWord = this._symbolType === 'class' ? 'exports' : 'callers';
		const calleeWord = this._symbolType === 'class' ? 'imports' : 'callees';
		countLabel.textContent = `${names.length} ${isCallers ? callerWord : calleeWord}`;
		nodeLayer.appendChild(countLabel);

		// Scrollable list via foreignObject
		const fo = document.createElementNS(SVG_NS, 'foreignObject') as SVGForeignObjectElement;
		fo.setAttribute('x', String(rx + 1));
		fo.setAttribute('y', String(ry + 1));
		fo.setAttribute('width', String(rectW - 2));
		fo.setAttribute('height', String(rectH - 2));

		const container = document.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLDivElement;
		container.style.cssText = [
			'width:100%', 'height:100%', 'overflow-y:auto', 'box-sizing:border-box',
			'padding:3px 0', 'scrollbar-width:thin',
			'scrollbar-color:rgba(130,165,190,0.35) transparent',
		].join(';');

		for (const name of names) {
			const item = document.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLDivElement;
			item.style.cssText = [
				'padding:2px 7px', 'font-family:monospace,"Courier New"', 'font-size:6.5px',
				'color:rgba(200,220,238,0.9)', 'white-space:nowrap', 'overflow:hidden',
				'text-overflow:ellipsis', 'cursor:pointer', 'border-radius:2px',
				'transition:background 0.1s',
			].join(';');
			item.title = name;
			item.textContent = name;
			item.addEventListener('mouseenter', () => { item.style.background = 'rgba(130,165,190,0.18)'; });
			item.addEventListener('mouseleave', () => { item.style.background = ''; });
			item.addEventListener('click', (e: MouseEvent) => {
				if (e.metaKey) {
					this._onNodeCmdClick(name);
				}
			});
			container.appendChild(item);
		}

		fo.appendChild(container);
		nodeLayer.appendChild(fo);
	}

	private _onNodeCmdClick(nodeName: string): void {
		this._cmdClickEmitter.fire(nodeName);
	}
}
