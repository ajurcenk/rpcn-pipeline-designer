import { builtinModules } from "node:module";
import typescriptEslint from "typescript-eslint";

// AD-15 dependency direction:
//   src/core   imports nothing from src/adapters or vscode (and spawns no processes).
//   src/shared imports nothing outside src/shared (no src/core, src/adapters, extension or vscode).
//   webview/   imports only src/shared (no vscode, Node built-ins, yaml or any other host code).
// Layer patterns match relative imports only, so npm packages such as `@babel/core` are not flagged.
const vscodeImport = {
    group: ["vscode"],
    message: "AD-15: this layer must not import the vscode API.",
};
const adaptersImport = {
    regex: "^\\.{1,2}/(.*/)?adapters(/|$)",
    message: "AD-15: src/core must not import from src/adapters.",
};
const childProcessImport = {
    group: ["child_process", "node:child_process"],
    message: "AD-9: only src/adapters/redpandaConnect spawns processes.",
};
// AD-2: only src/core parses YAML (src/test may, to check results).
const yamlImport = {
    group: ["yaml", "yaml/*"],
    message: "AD-2: only src/core parses YAML.",
};
const YAML_MODULE = "/^yaml(\\/.*)?$/";
const yamlSyntax = [
    {
        selector: `CallExpression[callee.name='require'][arguments.0.value=${YAML_MODULE}]`,
        message: yamlImport.message,
    },
    {
        selector: `ImportExpression[source.value=${YAML_MODULE}]`,
        message: yamlImport.message,
    },
];
const CHILD_PROCESS = "/^(node:)?child_process$/";
const childProcessSyntax = [
    {
        selector: `CallExpression[callee.name='require'][arguments.0.value=${CHILD_PROCESS}]`,
        message: childProcessImport.message,
    },
    {
        selector: `ImportExpression[source.value=${CHILD_PROCESS}]`,
        message: childProcessImport.message,
    },
];

// A file N folders below src/shared may climb at most N levels with `../`.
const MAX_SHARED_DEPTH = 6;
const sharedBlocks = Array.from({ length: MAX_SHARED_DEPTH }, (_, depth) => ({
    files: [`src/shared/${"*/".repeat(depth)}*.ts`],
    rules: {
        "no-restricted-imports": ["error", {
            patterns: [vscodeImport, childProcessImport, yamlImport, {
                // `depth` x `../` followed by `..` climbs out of src/shared.
                regex: `^(\\.\\./){${depth}}\\.\\.(/|$)`,
                message: "AD-15: src/shared must not import anything outside src/shared.",
            }],
        }],
        "no-restricted-syntax": ["error", ...childProcessSyntax, ...yamlSyntax],
    },
}));

// webview/ runs in the browser: no Node built-ins (bare, with a subpath, or any `node:` module).
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nodeBuiltinImport = {
    regex: `^(node:.*|(${builtinModules.map(escapeRegex).join("|")})(/.*)?)$`,
    message: "AD-15: webview/ runs in the browser and must not import Node built-ins.",
};
// The layer check below reads the leading `../` run, so a relative path may not use `.` or `..`
// segments after it (`../../src/shared/../core/x`, `.././../src/core/x`).
const nonNormalizedImport = {
    regex: "(/\\.(/|$))|(^\\./\\.\\.)|((^|/)[^./][^/]*/(.*/)?\\.\\.(/|$))",
    message: "AD-15: write relative imports in webview/ without `.` or `..` after the first folder name.",
};
// A relative import out of webview/ may only go into src/shared: from `webview/<depth dirs>/x.tsx`,
// any `../` chain that climbs above webview/ must continue with `src/shared/`.
const MAX_WEBVIEW_DEPTH = 6;
const webviewBlocks = Array.from({ length: MAX_WEBVIEW_DEPTH }, (_, depth) => ({
    files: [`webview/${"*/".repeat(depth)}*.{ts,tsx}`],
    rules: {
        "no-restricted-imports": ["error", {
            patterns: [vscodeImport, childProcessImport, yamlImport, nodeBuiltinImport, nonNormalizedImport, {
                // `depth` x `../` then one more `../` leaves webview/; only `src/shared` may follow.
                regex: `^(\\.\\./){${depth + 1}}(?!src/shared(/|$))`,
                message: "AD-15: webview/ imports only src/shared.",
            }],
        }],
        "no-restricted-syntax": ["error", ...childProcessSyntax, ...yamlSyntax],
    },
}));

export default [{
    files: ["**/*.ts", "**/*.mts", "**/*.tsx"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}, {
    files: ["src/core/**/*.ts"],
    rules: {
        "no-restricted-imports": ["error", {
            patterns: [vscodeImport, adaptersImport, childProcessImport],
        }],
        "no-restricted-syntax": ["error", ...childProcessSyntax],
    },
}, {
    files: ["src/adapters/**/*.ts", "src/extension.ts"],
    rules: {
        "no-restricted-imports": ["error", { patterns: [yamlImport] }],
        "no-restricted-syntax": ["error", ...yamlSyntax],
    },
}, ...sharedBlocks, ...webviewBlocks];
