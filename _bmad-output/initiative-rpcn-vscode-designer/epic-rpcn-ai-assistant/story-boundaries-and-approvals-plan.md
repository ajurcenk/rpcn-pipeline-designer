---
title: 'Boundaries and approvals'
type: 'feature'
ticket: '5'
created: '2026-11-25'
status: 'built'
baseline_revision: '099e538122cac1fdb8a47578536bfc894353fa03'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter','edge-case-hunter','verification-gap','intent-alignment','quick']
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-rpcn-ai-assistant/epic-rpcn-ai-assistant.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every shell command the agent improvises opens VS Code's modal, one after another, with only Allow or Deny, and nothing is remembered. The boundary rules are split between the hook and `canUseTool`. The stage's own artifact is hard-coded to the `Write` of a `.design.md`. Nothing checks that a run leaves the user's home untouched.

**Approach:**
- One rules module decides allow, deny or ask for every tool.
- An approval is a card in the chat turn, with Allow once, Allow for this session and Deny.
- The session memory remembers a parsed shell key, or a write tool, until the window reloads.
- A test proves that a run writes nothing under the user's home.

## Boundaries & Constraints

**Always:**
- **The rules:** in one place (`rules.ts`), used by both the PreToolUse hook and `canUseTool`, giving the same answer for the same call.
  - **Shell:** allowed without asking only for `uv run` of `rpcn_check.py` inside the active skills copy (unchanged). Everything else asks, unless the session memory holds its key.
  - **Writes:**
    - Outside the workspace: denied.
    - The running stage's own artifact: allowed. For `rpcn-design`, `Write`, `Edit` and `MultiEdit` of a `*.design.md` inside the workspace.
    - Other workspace writes: ask.
    - A table keyed by skill. 8.7 adds `rpcn-author`'s files.
  - **Reads:** Read, Glob and Grep inside the active skills copy are allowed. Others ask.
  - **Own tools:** `mcp__rpcn__*` are allowed.
  - **Anything else:** WebFetch, WebSearch, Task and unknown tools ask.
- **Shell key** (`shellKey(command)`, a small quote-aware lexer):
  - **Splitting:** `|` splits the command into stages. Within each stage:
    - leading `VAR=value` assignments and the wrappers `timeout <n>` and `env` are skipped;
    - the program is the first word's basename;
    - the key word is the program plus its leading non-option words, up to 2 (for example `rpk connect list`, `rpk cluster info`, `grep`).
  - **The key:** the stages' key words, joined with ` | `.
  - **No key:** the command gets none, so it always asks with no session choice, when any of these hold:
    - it contains `;`, `&&`, `||`, a lone `&`, backticks, `$(`, `<(` or `>(`;
    - it has a redirect to a file (`>` or `>>` to anything except `/dev/null`; `2>&1` is fine);
    - it contains `rpk connect run` or `rpk connect` with `-w` or `--watch`;
    - any stage's program is not on the read-only list.
  - **The read-only list:**
    - `rpk` (only `connect list|lint|blobl|version|fields`, `cluster info|health`, `topic list|describe`, `version`), `redpanda-connect` (the same `connect` subcommands);
    - `strings`, `grep`, `egrep`, `head`, `tail`, `cut`, `sort`, `uniq`, `wc`, `jq`, `cat`, `ls`, `echo`, `printf`;
    - `python3` only as `python3 -I -c <code>` reading stdin.
- **Approval card:**
  - **Where:** in the current turn, under its step row, one card per open approval. It shows the summary, the full detail (masked and selectable, with Copy command), and the buttons:
    - **Allow once**;
    - **Allow for this session**, shown only when the call has a session key, with the key named, for example "Allow `rpk connect list | python3` for this session";
    - **Deny**.
  - **No key:** the card says "This command always asks."
  - **Keyboard:** focus moves to the card when it appears. Escape is Deny.
  - **Withdrawn:** a withdrawn approval removes its card.
  - **The modal:** removed, along with `ui.approve`.
- **Session memory:**
  - **Where it lives:** in the view, in memory, for the window's life. It survives New conversation and is gone after a reload.
  - **Entries:** a shell key, or a write tool name. A remembered write tool applies to workspace writes only; outside is still denied.
  - **A remembered call:** allowed without a card. Its step row's result says "allowed (this session)".
- **The port:** `approve(id, decision)` takes `'once' | 'session' | 'deny'`. The approval event carries `sessionKey: string | null`, computed by the rules.
- **Environment:**
  - **`HOME`:** stays the user's real home, because `rpk` needs its profile and its connect plugin.
  - **Everything else:** `CLAUDE_CONFIG_DIR`, uv and XDG stay in the extension's storage, and `settingSources` stays `[]` (both unchanged).
  - **The home check:** a fake-model test runs with `HOME` set to a temp folder and asserts it holds no new entry after the run.
- **Masking:** all card text goes through the view's `mask()`.

**Never:**
- remembering an exact command text as a session key;
- a session key for anything outside the read-only list;
- a session choice that persists past a reload, or is stored on disk;
- auto-allowing writes outside the workspace;
- a VS Code modal for approvals;
- changing the `rpcn_check` rule.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error handling |
|---|---|---|---|
| RPCN_CHECK | `uv run <skills>/…/rpcn_check.py list` | Allowed, with no card | — |
| WS_CHECK | `uv run ws/evil/rpcn_check.py list` | Card, with no session choice | — |
| CHAINED | `uv run <skills>/rpcn_check.py list; rm x` | Card, with no session choice | — |
| PIPE_KEY | `~/.local/bin/rpk connect list --format jsonschema 2>/dev/null \| python3 -I -c "…"` | Card offering "Allow `rpk connect list \| python3` for this session" | — |
| SESSION_HIT | After Allow for this session, `rpk connect list --format json caches \| python3 -I -c "other"` | Allowed, no card; the row says "allowed (this session)" | — |
| SESSION_MISS | After that, `rpk cluster info` | Card (a different key) | — |
| RUN_ASKS | `printf '…' \| timeout 60 rpk connect run /tmp/x.yaml` | Card, with no session choice | — |
| REDIRECT | `rpk connect list > out.txt` | Card, with no session choice | — |
| ONCE | Allow once, then the same command | Card again | — |
| DENY | Deny | The tool is denied; the row is marked denied | — |
| OWN_NOTE | A design run's `Edit` of `x.design.md` | Allowed, with no card | — |
| OTHER_WRITE | `Write ws/a.yaml` in a design run; Allow for this session; a later `Write ws/b.yaml` | First a card, then allowed with no card | — |
| OUTSIDE | `Write /tmp/x` even after a session Write | Denied, with no card | — |
| TWO_OPEN | Two approvals open at once | Two cards, each settling its own approval | — |
| WITHDRAWN | Stop while a card is open | The card is removed; the run stops | — |
| RELOAD | The window reloads | The session memory is empty | — |
| HOME | A fake-model run with `HOME` as a temp folder | The temp home has no new entry | — |
| LEAK | A detail holding the key or the home path | Masked on the card | — |

## Decisions (the user, 2026-11-25)

- **`HOME`:** stays the user's real home, for `rpk`'s profile and its connect plugin. The test with a temp home proves that nothing new lands there.
- **The note:** the stage's own note is written or edited without asking (`Write`, `Edit` and `MultiEdit` of `*.design.md`).
- **`python3`:** `python3 -I -c` stays in the read-only list, so a chain holding it can be remembered for the session. The user accepts that its code is not checked.
- **Plan size:** about 2,700 tokens, kept as one story.
- **Amended after review pass 1 (the user, 2026-11-25):**
  - **Key hijack:** any leading `VAR=value`, or `env VAR=…`, means no key. A program can be keyed only as a bare name, or as an absolute or `~/` path that is outside the workspace and exists. A quoted `~` means no key. This replaces "assignments are skipped" and "the program is the first word's basename" for keying.
  - **Read paths:** a command gets a session key only when every path-like argument, and every `$VAR` expansion, stays inside the workspace or the skills copy. `~`, `/etc`, `$HOME` and other outside paths mean no key.
  - **Risky writes:** writes under `.git/` or `.vscode/`, and to `.envrc` or `.env*`, always get a card with no session choice, even after Allow for this session.
  - **Reads and Task:** Read, Glob and Grep inside the workspace or the skills copy are allowed with no card. Reads outside them, Task, WebFetch, WebSearch and unknown tools ask, and the hook forces the card instead of leaving the call to Claude Code. This replaces "Reads: … Others ask".
  - **How it is applied:** the existing code is patched in place, not reverted.

</frozen-after-approval>

## Code Map

- **`src/adapters/assistant/rules.ts`** (164 lines). Keep `isRpcnCheckCall` (l.64-99), `isInside` (l.54) and `realish` (l.37).
  - **`preToolUseDecision` (l.106) and `canUseToolDecision` (l.133):** merge them into one `decide(tool, input, ctx)` that both wrap. The write branch is duplicated today (l.110-113 against l.137-143).
  - **`STAGE_ARTIFACT` (l.32):** becomes a table keyed by skill. `BoundaryContext` (l.19) gains `skill`.
  - **New:** `shellKey`, and the read-only list.
  - **`approvalSummary`** (l.152) stays.
- **`src/adapters/assistant/host.ts`:**
  - the approval event (l.54) gains `sessionKey`;
  - `approve(id, allow: boolean)` (l.117) becomes `approve(id, decision: ApprovalDecision)`;
  - the session memory's lookup is passed into the host config as `isRemembered(key)`.
- **`src/adapters/assistant/agentSdkHost.ts`:**
  - **`canUseTool`** (l.309-335): compute the key. When `isRemembered(key)`, allow it and emit a `remembered{stepId}` event. Otherwise emit `approval{…, sessionKey}`.
  - **`approve`** (l.206): `'once'` and `'session'` allow, and `'deny'` denies.
  - Pass `skill` into the context.
- **`src/adapters/assistant/env.ts`:** leave it unchanged, apart from an explanatory comment that `HOME` stays the real home on purpose. The test gives `baseEnv.HOME` as a temp folder.
- **`src/adapters/vscode/assistantView.ts`:**
  - **Remove:** `ui.approve` (l.77, l.357-359) and the modal in `askApproval` (l.1027-1053).
  - **The open approvals:** keep them in the state; they are posted in the turn.
  - **New:** `sessionApprovals: Set<string>` on the view, not per turn.
  - **Results:** keep the decisions recorded on the step (l.233, l.929). Add "allowed (this session)".
- **Protocol `src/shared/assistantProtocol.ts`:**
  - Each turn gains `approvals: {id, summary, detail, sessionKey}[]`.
  - New webview message `approvalDecided{id, decision}`, with its parser.
  - `WAITING_APPROVAL_TEXT` ("…in the dialog") goes.
- **Webview:** a new `ApprovalCard.tsx`, following the `QuestionCards` pattern (`AssistantView.tsx` l.101), rendered in `Turn.tsx` where `live` is rendered (l.105). Reuse `CopyButton.tsx`.
- **Fake host `src/test/helpers/fakeAssistantHost.ts`:** `waitApproval` (l.126) takes a `sessionKey`, and `approvals` records the decision.
- **Tests:**
  - **`rules.test.ts`:** a table test of `shellKey` covering every Matrix shell row, plus the wrappers, quotes and `2>&1`. Keep the existing l.29-74.
  - **`99c-assistant.ts`:**
    - replace the `approveWith` seam (l.56-66, l.129-131) with posting `approvalDecided`;
    - update the approval tests (l.417, l.791-805, l.1317, l.1357);
    - add the fake-model rows and the HOME row (`baseEnv` with a temp `HOME`).

## Tasks & Acceptance

**Execution:**
- [x] `src/adapters/assistant/rules.ts` (+ `rules.test.ts`) -- `decide`, the stage artifact table, `shellKey` and the read-only list -- one source of the rules.
- [x] `src/adapters/assistant/host.ts`, `agentSdkHost.ts` -- the decision type, `sessionKey`, the remembered fast path -- the port.
- [x] `src/shared/assistantProtocol.ts` -- the turn's approvals and `approvalDecided` -- one contract.
- [x] `src/adapters/vscode/assistantView.ts` -- the session memory, the modal removed, posting approvals, decisions and Escape -- the host side.
- [x] `webview/src/assistant/ApprovalCard.tsx`, `Turn.tsx`, `AssistantView.tsx`, CSS (+ tests) -- the card -- in the chat.
- [x] `src/test/helpers/fakeAssistantHost.ts`, `src/test/integration/suites/99c-assistant.ts` -- every Matrix row except LEAK's webview half -- proof.
- [x] `README.md`, `CHANGELOG.md` -- approvals in the chat and what "this session" remembers.

**Acceptance Criteria:**
- Given an open approval, when the user presses Escape on the card, then the tool is denied.
- Given the whole stable suite, when it runs, then every 8.1, 8.2 and 8.12 assistant test still passes with the modal gone.

## Implementation Notes

- **The hook says `ask` for every ask** (review pass 1, amended "Reads and Task"). Claude Code runs a command it deems read-only (`echo once`) and a workspace read without calling `canUseTool`; the hook's `ask` sends each to `canUseTool` and a card. Claude Code's own Skill, TodoWrite and ToolSearch are allowed in `decide` (`INTERNAL_TOOLS`); a question stays `undefined`.
- **What the session key reads.** Only `rpk` and `redpanda-connect` take subcommand words (`rpk`: up to 2, `redpanda-connect`: 1); every other program keys on its name alone (so `grep x f` is `grep`). Beyond the plan's list, these also give no key: an input redirect (`<`, `<<`), a newline outside quotes, `env` with an option (`-S` can hide a command line), `sort -o`, `uniq <in> <out>` (both write a file), and a program that is a relative path or a path inside the workspace (a script the agent wrote, named `rpk`, is not `rpk`).
- **The card's detail** is the whole command for Bash and the file for a write (`approvalDetail`), else the SDK's title. The Copy button is labelled Copy command for all of them.
- **"allowed (this session)"** wins over the step's own result, both for a remembered call and for the call where the user chose Allow for this session; `allowed` (once) still gives way to the result.
- **Test seams:** `view.sessionKeys()` and `view.forgetSessionForTest()` (each test starts with an empty memory, as after a reload). The fake host's `waitApproval` with a `sessionKey` sends the approval itself, or `remembered` when the view holds the key. The suite's `approveWith` now decides each card as it appears in the current turn, by posting `approvalDecided`.
- **HOME** is checked by wrapping the real SDK host's factory with `baseEnv.HOME` set to a temporary folder, with no change to `env.ts` apart from its comment.

- **Manual check 1: tool-results reads.** Claude Code spills a large tool result to `<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>/tool-results/<id>.txt` and reads it back with Read; outside the workspace and the skills copy, that read asked every time with no session choice. `BoundaryContext.agentConfigDir` (the agent's `CLAUDE_CONFIG_DIR`, set in `agentSdkHost.ts` from `agentFolders`) now allows Read, Glob and Grep inside its `projects/` subtree only; the rest of the config folder and its siblings still ask, and writes there stay denied (outside the workspace). Claude Code writes those files itself, not through the Write tool.

## Plan Change Log

## Review Triage Log

**Pass 1 (5 lenses: blind, edge, verification gap, intent, quick):** 4 intent gaps, resolved by the user's answers and patched in place (the user's choice). By verdict, the remaining items are: high 0, medium 6, low 9, false/rejected 5.

| # | Finding (lenses) | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | The CSS selector slip: `.rpcn-assistant-state-body` is merged into `.rpcn-assistant-approvals`, and `margin:0` moved to the `pre` (all 5) | medium | patch | `assistant.css` l.107-113. The no-access text becomes a flex column with default margins. Restore `.rpcn-assistant-state-body { margin: 0; }` on its own. |
| 2 | A leading `PATH=`/`LD_PRELOAD=` assignment, `~/`, absolute or quoted-`~` programs are keyed by basename (blind, edge, vgap, quick) | high | intent_gap → amended | Checked: `shellKey('~/projects/ws/rpk connect list')` gives `rpk connect list`. Amended "Key hijack"; patch. |
| 3 | Remembered `cat`/`grep`/`head` keys read any path, including outside the workspace (blind) | high | intent_gap → amended | The key carries no arguments, so `head ~/.ssh/id_rsa` would run with no card. Amended "Read paths"; patch. |
| 4 | A session `Write` covers `.git/hooks`, `.vscode/tasks.json` and `.envrc` (blind, edge) | medium | intent_gap → amended | Amended "Risky writes"; patch. |
| 5 | Non-Bash asks are left to Claude Code, so workspace Read/Glob/Grep and Task never reach a card, and the parity test maps `undefined` to `ask` (intent, blind, edge, quick) | medium | intent_gap → amended | `preToolUseDecision` returns `undefined` for non-Bash asks. Amended "Reads and Task"; patch: the hook returns `ask` for every `decide` ask. The parity test then asserts that the hook's own result is `ask`. |
| 6 | `python3 -I -c` gets a key even when it is not reading a pipe (quick) | medium | patch | It deviates from the frozen "reading stdin". `stageKey` checks only the argument count. Patch: a key only when the stage index is > 0. |
| 7 | `sort --compress-program`/`-T`, `tail -f`/`--follow`, `rpk connect blobl server`, `wc --files0-from`, `jq --rawfile`/`--slurpfile` keep their keys (blind, edge, vgap, quick) | medium | patch | Checked `rpk connect blobl server` gives `rpk connect blobl`. These programs are not read-only with these options. Patch: they mean no key. |
| 8 | A second open card with the same key is not settled after a session decision (blind, edge) | medium | patch | `decideApproval` adds the key but leaves the other cards open. Patch: settle the open approvals whose key is now remembered as session. |
| 9 | The card renders after all the steps, not under its own step row (quick) | low | patch | It deviates from the frozen "under its step row". `Turn.tsx` l.107. Patch: render it under the matching `stepId` row, or at the end when there is none. |
| 10 | The card takes focus from the composer, and a second card takes focus from the first (blind, edge) | low | patch | Patch: focus only when focus is on the body or on no element. |
| 11 | The write card says "Copy command"; WebFetch/WebSearch show no URL or query (blind) | low | patch | Patch: "Copy path" for writes, and a detail of the URL or query from the input. |
| 12 | The README's `redpanda-connect` subcommands are wrong, and the always-ask cases are missing (blind) | low | patch | It is a doc fix. |
| 13 | The 99c `decided` set is never cleared in `setup` (blind) | low | patch | A test could hang across turns with repeated ids. Clear it in `setup`. |
| 14 | `session` on a card with no key is untested (vgap) | low | patch | Add one `receive` to the NO_KEY_CARD test: the host gets `'once'`, no key is stored, and the result is `allowed`. |
| 15 | A decision for an approval whose turn is not current leaves the host waiting (edge) | false | rejected | Open approvals are cleared by `closeOpen` when a turn ends, and a new run starts only once the previous turn has ended, so an open approval always belongs to the current turn. |
| 16 | `remembered` with no `stepId` leaves no trace in the turn (blind) | low | rejected | The SDK always gives `toolUseID` to `canUseTool`. Only a hypothetical adapter would leave it out, and it is logged. Fixing it adds a branch. |
| 17 | A double click sends two decisions (blind) | low | rejected | The host ignores the second (the id is no longer open). This is cosmetic. |
| 18 | The HOME test does not check the real home or an improvised `rpk` call (intent) | false | rejected | It matches the user's decision: the real `HOME` stays, for `rpk`'s profile. The test proves the agent's own writes go to its folders. |
| 19 | The stage artifact is still a table in code, not taken from the skill (intent) | false | rejected | The plan specifies a table keyed by skill, which 8.7 extends. |
| 20 | The write card shows no content preview (blind) | low | rejected | It is the same as the modal before, and Undo (8.12) covers the turn's writes. This is a new feature, not a defect. |

## Verification

**Commands:**
- `npm run compile && npm run test:webview` -- expected: pass.
- `npm run compile-tests`, then `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 900 xvfb-run -a npx vscode-test --label stable --grep "assistant"` -- expected: pass.
- The full stable suite twice, then `--label multiroot` -- expected: all pass. Run one at a time; never `--label floor`.

**Manual checks:**
- The user's request from manual check 2 of 8.12 (the dedupe question), in the dev host, with at most 2 real runs. The approvals are cards in the chat, and Allow for this session stops the repeated `rpk connect list | python3` prompts.

### Orchestrator verification (after pass-1 fixes and the tool-results fix, 2026-11-25)

- **Builds and webview tests:** `npm run compile` passed; `npm run test:webview` 483/483; `npm run compile-tests` passed.
- **Full stable suite:**
  - **Run 1:** 1935 passing, 1 pending.
  - **Run 2:** 1934 passing and 1 failing: `GRAPH FIGURES (7.3)`, a metrics test that timed out after 90 s. This run took 23 minutes against the usual 14, with the dev host open, and the same test timed out the same way during 8.2.
  - **Run 3:** 1935 passing, 1 pending.
- **Multi-root:** 15 passing. No floor run.

## Manual Check

- 2026-11-25, the user, VS Code 1.143.1 dev host from `.vscode-test`, through a Redpanda ADP endpoint (a new provider URL and key, on `claude-sonnet-4-6`, because the provider refuses `claude-opus-5-5`).
- Approvals were cards in the chat, and Allow for this session settled repeated keys.
- One bug was found and fixed: a card appeared for Claude Code reading back its own `tool-results` spill file. Reads inside `<CLAUDE_CONFIG_DIR>/projects/` are now allowed.
- The final check passed with no issues.
- **Follow-ups, recorded in 8.3's ticket:**
  - the model chip with relative cost marks;
  - mapping "Not logged in · Please run /login" and a 403 "model … is not allowed" to the access states.
