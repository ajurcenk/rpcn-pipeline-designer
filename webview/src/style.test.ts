// TOKENS (ticket 3.4, DESIGN Colors): every colour in webview/src/*.css (and the Bloblang panel's
// webview/src/bloblang/*.css, ticket 4.2) is a VS Code theme variable. No hex, rgb(), hsl() or named colour outside `var(--vscode-…)`.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('./', import.meta.url);
const SHEETS = [
	...readdirSync(DIR).filter((f) => f.endsWith('.css')),
	...readdirSync(new URL('bloblang/', DIR)).filter((f) => f.endsWith('.css')).map((f) => `bloblang/${f}`),
];

// CSS named colours (CSS Color 4), plus the system colours that would bypass the theme.
const NAMED = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod
darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown
royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow
springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight
highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext`.split(/\s+/);

/** The declaration values of a stylesheet, with comments and theme variable names removed. */
function values(css: string): string[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	return [...text.matchAll(/[\w-]+\s*:\s*([^;{}]+)[;}]/g)]
		.map((m) => m[1].replace(/var\(\s*--vscode-[\w-]+/g, 'var('));
}

/** The colours a value names directly. */
function rawColours(value: string): string[] {
	const found = [
		...value.match(/#[0-9a-f]{3,8}\b/gi) ?? [],
		...value.match(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? [],
	];
	const words = value.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
	return [...found, ...words.filter((w) => NAMED.includes(w))];
}

describe('TOKENS', () => {
	it('finds the stylesheets', () => {
		expect(SHEETS).toContain('graph.css');
		expect(SHEETS).toContain('bloblang/bloblang.css');
	});
	it('catches raw colours', () => {
		expect(rawColours('1px solid #fff')).toEqual(['#fff']);
		expect(rawColours('rgb(0, 0, 0)')).toEqual(['rgb(']);
		expect(rawColours('hsl(0 0% 0%)')).toEqual(['hsl(']);
		expect(rawColours('1px solid red')).toEqual(['red']);
		expect(rawColours('var(, transparent)')).toEqual([]);
	});
	for (const sheet of SHEETS) {
		it(sheet, () => {
			const css = readFileSync(new URL(sheet, DIR), 'utf8');
			const bad = values(css).flatMap((v) => rawColours(v).map((c) => `${c} in "${v.trim()}"`));
			expect(bad).toEqual([]);
		});
	}
});

describe('MARKERS (ticket 3.8, DESIGN pipeline-node-error / -warning)', () => {
	const css = readFileSync(new URL('graph.css', DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	/** The declarations of every rule whose selector list names `selector`, joined. */
	const rule = (selector: string) => [...css.matchAll(new RegExp(`(^|[},])\\s*${selector.replace(/[.-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'gm'))]
		.map((m) => m[2]).join('\n');
	it('a 2px border in the error and warning border tokens', () => {
		expect(rule('.pipeline-node-warning')).toMatch(/border-width:\s*2px/);
		expect(rule('.pipeline-node-error')).toContain('var(--vscode-inputValidation-errorBorder)');
		expect(rule('.pipeline-node-warning')).toContain('var(--vscode-editorWarning-border, var(--vscode-editorWarning-foreground))');
	});
	it('the icon in the error and warning tokens', () => {
		expect(rule('.pipeline-node-error .rpcn-status-icon')).toContain('var(--vscode-errorForeground)');
		expect(rule('.pipeline-node-warning .rpcn-status-icon')).toContain('var(--vscode-editorWarning-foreground)');
	});
	it('SIZING: the boxes are border-box at the laid-out size, and the extra border pixel is given back', () => {
		expect(rule('.rpcn-node')).toMatch(/box-sizing:\s*border-box/);
		expect(rule('.rpcn-node')).toMatch(/width:\s*100%/);
		expect(rule('.rpcn-route')).toMatch(/box-sizing:\s*border-box/);
		// 4px 8px less one pixel on every side (the right also leaves room for the icon).
		expect(rule('.rpcn-node.pipeline-node-warning')).toMatch(/padding:\s*3px 23px 3px 7px/);
		expect(rule('.pipeline-node-warning > .rpcn-route-caption')).toMatch(/margin:\s*-1px -1px 0/);
		expect(rule('.pipeline-node-warning > .rpcn-group-summary')).toMatch(/margin:\s*0 -1px/);
	});
});

describe('FOCUS (ticket 11, DESIGN pipeline-node-focused)', () => {
	const css = readFileSync(new URL('graph.css', DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	it('a focused node and the container get the 1px focusBorder ring, and nothing removes it', () => {
		const block = (selector: string) => new RegExp(`${selector.replace(/[.-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
		expect(block('.rpcn-graph .react-flow__node:focus-visible')).toMatch(/outline:\s*1px solid var\(--vscode-focusBorder\)/);
		expect(block('.rpcn-graph:focus-visible')).toMatch(/outline:\s*1px solid var\(--vscode-focusBorder\)/);
		// F3: the no-binary empty state and the empty canvas region take focus, with the same ring.
		expect(block('.rpcn-empty:focus-visible')).toMatch(/outline:\s*1px solid var\(--vscode-focusBorder\)/);
		expect(block('.rpcn-canvas-region:focus-visible')).toMatch(/outline:\s*1px solid var\(--vscode-focusBorder\)/);
		expect(css).not.toMatch(/outline:\s*(none|0)\b/);
	});
});

describe('FOCUS and CONTRAST (ticket 4.11, DESIGN test panel)', () => {
	const css = readFileSync(new URL('bloblang/bloblang.css', DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	/** The declarations of every rule whose selector list has `selector` as one of its selectors, joined. */
	const rule = (selector: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
		.filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
		.map((m) => m[2]).join('\n');
	const RING = /outline:\s*1px solid var\(--vscode-focusBorder\)/;
	const CONTRAST = 'var(--vscode-contrastBorder, transparent)';
	// Every focusable element of the panel: the content input, Run, the tabs, the links (Go to line,
	// the metadata rows'), Run on change, the metadata inputs, the output content, the removed and
	// no-binary regions and the no-binary buttons, the sample picker, the rename field, the buttons.
	const FOCUSABLE = [
		'.rpcn-bl-input', '.rpcn-bl-run', '.rpcn-bl-tab', '.rpcn-bl-link', '.rpcn-bl-auto', '.rpcn-bl-meta input', '.rpcn-bl-output',
		'.rpcn-bl-removed', '.rpcn-bl-nobin', '.rpcn-bl-nobin-act', '.rpcn-bl-sample', '.rpcn-bl-sample-name', '.rpcn-bl-btn',
	];
	it.each(FOCUSABLE)('%s shows the 1px focusBorder ring on :focus-visible', (selector) => {
		expect(rule(`${selector}:focus-visible`)).toMatch(RING);
	});
	it('nothing removes outlines', () => {
		expect(css).not.toMatch(/outline(-style)?:\s*(none|0)\b/);
	});
	it.each([
		'.rpcn-bl-pill', '.rpcn-bl-card', '.rpcn-bl-removed', '.rpcn-bl-nobin', '.rpcn-bl-labelnote', '.rpcn-bl-col',
		'.rpcn-bl-kind', '.rpcn-bl-badge', '.rpcn-bl-tab', '.rpcn-bl-link',
	])(
		'%s adds the 1px contrast border', (selector) => {
			expect(rule(selector)).toContain(`1px solid ${CONTRAST}`);
		},
	);
	it.each(['.rpcn-bl-run', '.rpcn-bl-btn', '.rpcn-bl-nobin-act'])('%s\'s border falls back to the contrast border', (selector) => {
		expect(rule(selector)).toContain(`border: 1px solid var(--vscode-button-border, ${CONTRAST})`);
	});
});
