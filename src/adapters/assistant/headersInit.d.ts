// Story 8.1: the Agent SDK's types pull in `@modelcontextprotocol/sdk`, whose declarations name the DOM's
// global `HeadersInit`. The extension compiles against Node's types only (no DOM lib), where it is
// `undici-types`' export, not a global: declared here as that type, for type checking only.
type HeadersInit = import('undici-types').HeadersInit;
