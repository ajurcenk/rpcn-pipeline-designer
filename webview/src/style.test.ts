// TOKENS (ticket 3.4, DESIGN Colors): every colour in webview/src/*.css is a VS Code theme
// variable. No hex, rgb(), hsl() or named colour outside `var(--vscode-…)`.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('./', import.meta.url);
const SHEETS = readdirSync(DIR).filter((f) => f.endsWith('.css'));

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
