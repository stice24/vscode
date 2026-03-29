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

`;
	mainWindow.document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data shape for the call graph slot. */
export interface CallGraphData {
	/** Names of functions that call the centre symbol. */
	callers: string[];
	/** Names of functions the centre symbol calls. */
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
 * Slot 1 — Call Graph.
 *
 * Renders a directed node graph: callers branch in from the left, the
 * highlighted symbol sits in the centre, callees branch out to the right.
 * Cmd-click on any node is stubbed here — navigation is wired in session 5.
 */
export class CallGraphSlot extends SlotComponent {

	private readonly _cmdClickEmitter = this._register(new Emitter<string>());
	/** Fired when the user cmd-clicks a node. Payload is the symbol name. */
	readonly onNodeCmdClick = this._cmdClickEmitter.event;

	private readonly _symbolName: string;

	constructor(container: HTMLElement, symbolName: string) {
		super(container, 'Call Graph');
		this._symbolName = symbolName || 'symbol';
		ensureCallGraphStyles();
	}

	override renderContent(data: unknown): void {
		const { callers, callees } = data as CallGraphData;
		this.setState('success');
		this._renderGraph(callers, callees);
	}

	// -------------------------------------------------------------------------
	// SVG graph construction
	// -------------------------------------------------------------------------

	private _renderGraph(callers: string[], callees: string[]): void {
		const vw = 300;
		const vh = 108;

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
		arrowPoly.setAttribute('fill', 'rgba(100, 128, 148, 0.55)');
		marker.appendChild(arrowPoly);
		defs.appendChild(marker);
		svg.appendChild(defs);

		const centerR = 18;
		const nodeR = 11;
		const center: IPoint = { x: vw / 2, y: vh / 2 };
		const callerX = 58;
		const calleeX = vw - 58;

		/** Distribute n nodes evenly in the vertical space, centred on vh/2. */
		const layoutY = (count: number, index: number): number => {
			if (count === 1) {
				return vh / 2;
			}
			const spacing = Math.min(46, (vh - nodeR * 4) / (count - 1));
			const totalSpan = spacing * (count - 1);
			return (vh / 2) - (totalSpan / 2) + index * spacing;
		};

		// Edges drawn first so nodes render on top
		const edgeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		const nodeLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		svg.appendChild(edgeLayer);
		svg.appendChild(nodeLayer);

		callers.forEach((name, i) => {
			const pos: IPoint = { x: callerX, y: layoutY(callers.length, i) };
			this._appendEdge(edgeLayer, edgePoints(pos, nodeR, center, centerR));
			this._appendNode(nodeLayer, pos, nodeR, name, false);
		});

		callees.forEach((name, i) => {
			const pos: IPoint = { x: calleeX, y: layoutY(callees.length, i) };
			this._appendEdge(edgeLayer, edgePoints(center, centerR, pos, nodeR));
			this._appendNode(nodeLayer, pos, nodeR, name, false);
		});

		// Centre node drawn last — sits on top of all edges
		this._appendNode(nodeLayer, center, centerR, this._symbolName, true);

		this.element.appendChild(svg);
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
		line.setAttribute('stroke', 'rgba(100, 128, 148, 0.38)');
		line.setAttribute('stroke-width', '1');
		line.setAttribute('marker-end', 'url(#ctx-cg-arrow)');
		parent.appendChild(line);
	}

	private _appendNode(
		parent: SVGGElement,
		pos: IPoint,
		r: number,
		name: string,
		isCenter: boolean
	): void {
		const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
		g.classList.add('call-graph-node');

		const circle = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
		circle.setAttribute('cx', String(pos.x));
		circle.setAttribute('cy', String(pos.y));
		circle.setAttribute('r', String(r));
		circle.setAttribute('fill', isCenter ? 'rgba(78, 201, 176, 0.15)' : 'rgba(100, 128, 148, 0.15)');
		circle.setAttribute('stroke', isCenter ? 'rgba(78, 201, 176, 0.65)' : 'rgba(100, 128, 148, 0.45)');
		circle.setAttribute('stroke-width', '1');

		const label = truncate(name, isCenter ? 11 : 9);
		const text = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
		text.setAttribute('x', String(pos.x));
		text.setAttribute('font-size', '7.5');
		text.setAttribute('font-family', 'monospace, "Courier New"');
		text.setAttribute('text-anchor', 'middle');

		if (isCenter) {
			text.setAttribute('y', String(pos.y));
			text.setAttribute('dominant-baseline', 'middle');
			text.setAttribute('fill', 'rgba(78, 201, 176, 0.9)');
		} else {
			// Label below circle
			text.setAttribute('y', String(pos.y + r + 9));
			text.setAttribute('dominant-baseline', 'auto');
			text.setAttribute('fill', 'rgba(155, 172, 185, 0.82)');
		}
		text.textContent = label;

		g.appendChild(circle);
		g.appendChild(text);

		// Cmd-click stub — navigation to this symbol wired in session 5
		g.addEventListener('click', (e: MouseEvent) => {
			if (e.metaKey) {
				this._onNodeCmdClick(name);
			}
		});

		parent.appendChild(g);
	}

	private _onNodeCmdClick(nodeName: string): void {
		this._cmdClickEmitter.fire(nodeName);
	}
}
