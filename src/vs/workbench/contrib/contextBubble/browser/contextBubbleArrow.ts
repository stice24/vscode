/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sits above the editor surface (suggest: 40, bubble: 50) but below the bubble
 * so the arrow renders between them visually.
 */
const ARROW_Z_INDEX = 49;

/** Stroke colour: muted cyan, low opacity. */
const ARROW_COLOR = 'rgba(80, 200, 220, 0.35)';
const ARROW_STROKE_WIDTH = 1.5;

/** Time before the arrow begins fading, in milliseconds. */
const FADE_DELAY_MS = 5000;

/** Duration of the opacity fade-out transition, in milliseconds. */
const FADE_DURATION_MS = 800;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IPoint {
	readonly x: number;
	readonly y: number;
}

// ---------------------------------------------------------------------------
// Arrow
// ---------------------------------------------------------------------------

/**
 * Renders a cubic bezier SVG arrow connecting the gutter anchor to the bubble.
 *
 * The SVG fills the entire workbench container and has `pointer-events: none`
 * so it does not interfere with any other UI.
 *
 * **Fade behaviour**
 * - The 5-second timer starts the first time `update()` is called
 * - The timer is NEVER reset — the arrow always fades exactly 5 s after it first appears,
 *   regardless of dragging or any other interaction
 * - `dismissImmediately()` is available for explicit teardown (e.g. session close)
 */
export class ContextBubbleArrow extends Disposable {

	private readonly _svgEl: SVGSVGElement;
	private readonly _pathEl: SVGPathElement;
	private _fadeTimeoutId: ReturnType<typeof setTimeout> | undefined;
	private _timerStarted = false;

	constructor(private readonly _container: HTMLElement) {
		super();
		this._svgEl = this._buildSvg();
		this._pathEl = this._buildPath();
		this._svgEl.appendChild(this._pathEl);
		this._container.appendChild(this._svgEl);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Redraws the bezier path between `from` and `to`
	 * (both expressed in container-relative pixel coordinates).
	 *
	 * Starts the 5-second fade timer on the first call. Subsequent calls only
	 * update the path — the timer is never reset.
	 */
	update(from: IPoint, to: IPoint): void {
		this._pathEl.setAttribute('d', this._computePath(from, to));
		if (!this._timerStarted) {
			this._timerStarted = true;
			this._startFadeTimer();
		}
	}

	/**
	 * Immediately collapses opacity to 0.
	 * Use for explicit teardown (e.g. when the session ends mid-flight).
	 */
	dismissImmediately(): void {
		this._clearFadeTimer();
		this._svgEl.style.transition = 'none';
		this._svgEl.style.opacity = '0';
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	private _buildSvg(): SVGSVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.style.cssText = [
			'position: absolute',
			'inset: 0',
			`z-index: ${ARROW_Z_INDEX}`,
			'width: 100%',
			'height: 100%',
			'pointer-events: none',
			'overflow: visible',
			'opacity: 1',
			'transition: none',
		].join('; ');
		return svg;
	}

	private _buildPath(): SVGPathElement {
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', ARROW_COLOR);
		path.setAttribute('stroke-width', String(ARROW_STROKE_WIDTH));
		path.setAttribute('stroke-linecap', 'round');
		return path;
	}

	/**
	 * Cubic bezier with horizontal tangents at both endpoints.
	 * This produces a smooth S-curve regardless of relative position.
	 */
	private _computePath(from: IPoint, to: IPoint): string {
		const dx = Math.abs(to.x - from.x);
		const cp1x = from.x + dx * 0.55;
		const cp1y = from.y;
		const cp2x = to.x - dx * 0.4;
		const cp2y = to.y;
		return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
	}

	private _startFadeTimer(): void {
		this._svgEl.style.transition = 'none';
		this._svgEl.style.opacity = '1';
		this._fadeTimeoutId = setTimeout(() => {
			this._svgEl.style.transition = `opacity ${FADE_DURATION_MS}ms ease-out`;
			this._svgEl.style.opacity = '0';
		}, FADE_DELAY_MS);
	}

	private _clearFadeTimer(): void {
		if (this._fadeTimeoutId !== undefined) {
			clearTimeout(this._fadeTimeoutId);
			this._fadeTimeoutId = undefined;
		}
	}

	override dispose(): void {
		this._clearFadeTimer();
		this._svgEl.remove();
		super.dispose();
	}
}
