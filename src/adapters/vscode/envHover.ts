// The variable hover (ticket 34): on `${NAME}`, `${NAME:default}` and `env("NAME")` (a literal
// name) in a detected config, the value the commands get, its source (with the settings level or
// the env file's line), and each weaker source it overrides. Read from the Environment view's own
// model for that config, computed on each hover, so its sources, precedence, states and masking are
// the view's: secret, env-file and VS Code environment values show as the mask, with "Show value"
// revealing that row in the view; `redpandaConnect.env` and the extension's `NO_COLOR` in clear. A
// variable nothing sets offers "Set variable…" (the view's set action); a default in use is shown.
// It sits beside the Bloblang and YAML hovers (VS Code shows them all). Its command links run only
// the two commands below, and carry the config URI, the source and the name, never a value.

import * as path from 'path';
import * as vscode from 'vscode';
import { envReferenceAt } from '../../core/envUsage';
import type { EnvironmentModel, EnvironmentVariable } from './environmentModel';
import { masksValue, REVEAL_VARIABLE_COMMAND, SET_MISSING_COMMAND, SOURCE_LABELS, variableStateText, VIEW_MASK } from './environmentView';

/** The commands the hover's links may run. */
export const ENV_HOVER_COMMANDS: readonly string[] = [REVEAL_VARIABLE_COMMAND, SET_MISSING_COMMAND];
/** The hover's first line starts with this (the test seam tells it from the other hovers by it). */
export const ENV_HOVER_TITLE = 'Environment variable';
/** The longest value shown in clear; a longer one is cut with `…`. */
const MAX_SHOWN = 200;

export interface EnvHoverOptions {
	readonly isDetected: (uri: vscode.Uri) => boolean;
	/** The Environment view's model for a config, read now. */
	readonly modelFor: (uri: vscode.Uri) => EnvironmentModel;
}

/** `text` as an inline code span (a fence longer than any backtick run in it). */
function code(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = '`'.repeat(longest + 1);
	const pad = text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** A value for the hover: one line, cut, quoted like the view's (`(empty)` for none). */
function shownValue(value: string): string {
	const one = JSON.stringify(value.replace(/\r?\n/g, '⏎')).slice(1, -1);
	const cut = one.length > MAX_SHOWN ? `${one.slice(0, MAX_SHOWN)}…` : one;
	return cut === '' ? '(empty)' : code(cut);
}

function commandLink(label: string, command: string, args: readonly unknown[]): string {
	const encoded = encodeURIComponent(JSON.stringify(args)).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `[${label}](command:${command}?${encoded})`;
}

/** Where a row comes from: its source, with the settings level or the env file and line. */
function origin(v: EnvironmentVariable, model: EnvironmentModel): string {
	const where = v.level ? `${v.level} settings`
		: v.source === 'envFile' && model.envFilePath ? `${path.basename(model.envFilePath)}${v.line !== undefined ? `, line ${v.line}` : ''}`
			: undefined;
	return `**${SOURCE_LABELS[v.source]}**${where ? ` (${where})` : ''}`;
}

/** The hover's markdown for `name` at a use (with its default, if any). Pure but for `vscode.MarkdownString`. */
export function envHoverMarkdown(model: EnvironmentModel, configUri: vscode.Uri, name: string, defaultValue: string | undefined): vscode.MarkdownString {
	const rows = model.groups.flatMap((g) => g.variables).filter((v) => v.name === name);
	const used = rows.find((v) => v.state === 'used');
	const lines: string[] = [`**${ENV_HOVER_TITLE}** ${code(name)}`];
	if (used) {
		const masked = masksValue(used.source, used.name) && used.value !== undefined;
		const value = used.value === undefined ? 'no value' : masked ? code(VIEW_MASK) : shownValue(used.value);
		const show = masked ? ` · ${commandLink('Show value', REVEAL_VARIABLE_COMMAND, [configUri.toString(), used.source, name])}` : '';
		lines.push(`${value} from ${origin(used, model)}${show}`);
	} else if (defaultValue !== undefined) {
		lines.push(`Not set: the default ${shownValue(defaultValue)} is used.`);
	} else {
		lines.push(`Missing: the config uses it without a default and no source sets it. ${commandLink('Set variable…', SET_MISSING_COMMAND, [name, configUri.toString()])}`);
	}
	const overridden = rows.filter((v) => v.state === 'overridden');
	if (overridden.length > 0) {
		lines.push(`Overrides: ${overridden.map((v) => origin(v, model)).join(', ')}`);
	}
	for (const v of rows.filter((r) => r.state === 'noValue' || r.state === 'ignored')) {
		lines.push(`${origin(v, model)}: ${variableStateText(v)}`);
	}
	if (model.envFileNote) {
		lines.push(`Env file: ${model.envFileNote}`);
	}
	const md = new vscode.MarkdownString(lines.join('\n\n'));
	md.isTrusted = { enabledCommands: [...ENV_HOVER_COMMANDS] };
	return md;
}

export class EnvHoverProvider implements vscode.HoverProvider {
	constructor(private readonly options: EnvHoverOptions) {}

	provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		try {
			if (!this.options.isDetected(doc.uri)) {
				return undefined;
			}
			const use = envReferenceAt(doc.getText(), doc.offsetAt(position));
			if (!use) {
				return undefined;
			}
			const markdown = envHoverMarkdown(this.options.modelFor(doc.uri), doc.uri, use.name, use.default);
			return new vscode.Hover(markdown, new vscode.Range(doc.positionAt(use.start), doc.positionAt(use.end)));
		} catch {
			return undefined;
		}
	}
}
