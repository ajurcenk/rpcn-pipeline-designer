import typescriptEslint from "typescript-eslint";

// AD-15 dependency direction:
//   src/core   imports nothing from src/adapters or vscode (and spawns no processes).
//   src/shared imports nothing outside src/shared (no src/core, src/adapters, extension or vscode).
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

export default [{
    files: ["**/*.ts", "**/*.mts"],
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
}, ...sharedBlocks];
