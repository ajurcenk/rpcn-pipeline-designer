---
title: 'The chat view, in the prototype''s option A layout'
type: 'feature'
ticket: '12'
created: '2026-11-25'
status: 'built'
baseline_revision: '3934442c8c346bd7873ff77aa695db952686a6be'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/epic-rpcn-ai-assistant/epic-rpcn-ai-assistant.md'
  - '{project-root}/_bmad-output/initiative-rpcn-vscode-designer/ux-rpcn-vscode-designer/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Today the assistant view is a request box, a list of one-line progress strings and a note badge. It drops the agent's reply and every tool result, and it cannot show or undo what a run changed. The user chose the prototype's option A, a chat transcript (artboard ChatA), as the layout for the epic.

**Approach:** Replace the view's state with a list of turns that the host builds from richer port events. Each turn shows the user's message, rpcn's skill, its step rows, the reply as safe Markdown, its files with +N/−N and a diff, Keep and Undo, and next-step buttons and chips. A composer with slash commands goes below. Before a turn's first write to a path, the host snapshots that file, so the turn can diff and restore it. 8.6, 8.7 and 8.9 fill the slots for their stages.

## Boundaries & Constraints

**Always:**
- The layout is option A, without the History button.
  - **Header:** RPCN ASSISTANT, with New conversation, which clears the transcript and the pending snapshots.
  - **Stage strip:** Design › Author › Test, plus the target folder. Design gets ✓ when this conversation's note is `ready`.
  - **Transcript:** each turn shows
    1. the user's message, with its slash command highlighted;
    2. the rpcn header with `· <skill>`;
    3. the step rows, each with a mark (running, ok or failed), a label and a short result;
    4. the reply;
    5. the file rows;
    6. Keep, Undo and the next-step buttons;
    7. the chips.
  - Earlier turns fold their steps to one line, which opens on click.
- **Composer:**
  - **Typing:** Enter sends and Shift+Enter starts a new line. Typing `/` at the start opens a list of `/design`, `/build` and `/test`. Arrow keys move through it, Enter or Tab picks, and Escape closes it.
  - **While a run is busy:** the composer stays, and Send becomes Stop.
  - **A message with no command:** it is `/design`.
- **The existing states, inside the chat:**
  - **Before any turn:** access, runtime, skills problem and the "Skills: local copy" line, as a panel in the transcript with its one button.
  - **In the current turn:**
    - the question cards, in the existing `QuestionCards` behaviour;
    - while the approval modal is open, a row saying the run is waiting for it;
    - stopped, as a muted line;
    - error, as an alert.
- **Step rows:**
  - **Events:** the port adds `step{id,label}` (from each top-level `tool_use`) and `stepDone{id,ok,result}` (from its `tool_result`). The label comes from the existing `toolProgress`.
  - **Short result:** a per-tool summariser, at most 60 characters. Failed shows the first line of the error. The fallback is empty. 8.4 adds summarisers for the rpcn tools.
- **Reply:**
  - **Text:** the full top-level assistant text of the turn, where today `events.ts` clips it to one line. It is masked on the host, and capped at 20,000 characters per turn.
  - **Markdown:** rendered with no HTML injection (Decisions).
  - **Links:** a click posts to the host. The host opens `http(s)` links with `vscode.env.openExternal` and workspace files in the editor, and ignores anything else.
- **Snapshots:**
  - **When:** before a run's first write to a path, through the PreToolUse hook on Write|Edit|MultiEdit|NotebookEdit, or the fake host's `write` step. The port emits `fileChanging{path, before: string|null}`, where `null` means the file did not exist.
  - **Size:** files over 1 MB are not snapshotted. Their row shows "too large to undo", and Undo leaves them alone.
  - **Storage:** snapshots are kept in memory only.
- **File rows:**
  - **When they appear:** when the turn ends, for each snapshotted path whose content now differs.
  - **Counts:** +N/−N line counts from a small line diff in `src/shared`.
  - **Diff:** a click opens `vscode.diff`. Its left side is a read-only `rpcn-assistant-before:` document with the snapshot, or empty for a new file. Its right side is the file.
- **Keep and Undo:**
  - **Keep** drops the turn's snapshots and hides both buttons.
  - **Undo** restores every file to its snapshot, deleting the files the turn created, then marks the turn undone.
  - Both are offered only on a turn that wrote files, and only once it has ended.
- **Next-step buttons and chips:** host-provided slots. This story fills only Open note on a design turn with a note. 8.6, 8.7 and 8.9 add Open graph, Run locally, Test and their chips.
- **Theme colours only:** `var(--vscode-*)`, with no hex in the CSS. Masking stays host-side. Every text posted to the webview goes through the view's `mask()`.
- **Limits:** at most 50 turns in a conversation, with the oldest dropped first. At most 200 steps per turn.

**Never:**
- carrying context from one turn to the next (follow-up messages are 8.6, and every Send here starts a fresh run, as now);
- restoring the chat after a reload;
- a History button;
- approval prompts drawn in the view (8.5);
- the stage strip read from disk (8.6/8.13);
- running `rpcn-author` or `rpcn-test` from the composer here (Decisions);
- `dangerouslySetInnerHTML` or `innerHTML`;
- a webview script or style from outside the bundle;
- writing a snapshot to disk.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error handling |
|---|---|---|---|
| HAPPY_DESIGN | `/design <request>` → steps → questions → answers → note written | One turn: the steps ✓ with results, the cards in the turn, the reply as Markdown, a row `x.design.md +N`, Keep, Undo and Open note | — |
| DIFF | Click a file row | `vscode.diff` of before ↔ now. A new file has an empty left side | Path missing now: an info message, with no diff |
| UNDO_NEW | The turn created `a.yaml` and `a.design.md`; Undo | Both deleted; the turn shows "Undone" | A delete fails: an error line in the turn, and the others are still restored |
| UNDO_EDIT | The turn edited an existing file; Undo | The file is byte-identical to its snapshot | — |
| UNDO_LATER_EDIT | The user edited the file after the turn ended; Undo | A modal asks first; Cancel restores nothing, OK restores every file | — |
| KEEP | Keep | The buttons are hidden and the snapshots dropped. The rows stay as text, no longer clickable | — |
| NO_CHANGE | A write was denied, or it wrote the same bytes | No file row, and no Keep or Undo | — |
| BIG_FILE | The turn writes a file over 1 MB | Its row is marked "too large to undo", with no diff and no restore | — |
| STEP_FAIL | `tool_result` with `is_error` | A ✗ mark, with the first line of the error as the result | — |
| SUBAGENT | A message with `parent_tool_use_id` | No step row (unchanged) | — |
| SLASH | `/` typed, ↓, Enter | `/build ` is inserted, and the list closes | — |
| PLAIN | A message with no command | Runs `rpcn-design`; the user's turn shows the text as typed | — |
| STATES | No access, runtime missing/installing/failed, bad skills path, question, approval, stopped, error, runtime vanishing mid-run | Each renders inside the chat, with its existing text and button | — |
| NEW_CONV | New conversation while idle; while busy | Idle: the transcript and snapshots are cleared. Busy: the run stops first, then everything is cleared | — |
| LEAK | Reply, step result or path holding the key, `Bearer …` or the home path | Masked in every posted message | — |
| MD_HOSTILE | A reply with `<script>`, `<img onerror>` or `[x](javascript:…)` | Rendered as text; no element or handler is created, and the link is inert | — |

## Decisions (the user, 2026-11-25)

- **Markdown:** a small hand-written renderer that builds React elements for paragraphs, headings, bold, italic, inline code, fenced code, lists, links and tables. There is no HTML path and no new dependency.
- **Earlier turns:** sending a new message keeps the previous turn's changes, so only the latest turn offers Keep and Undo.
- **`/build` and `/test`:** listed in the autocomplete and the chips, but disabled, with the hints "Arrives with the Author stage" and "Arrives with the Test hand-off". Nothing runs `rpcn-author` or `rpcn-test` here.
- **Undo after later edits:** when a file's content differs from what the turn left, Undo first asks: "Undo will discard your edits to `<file>` since the turn." Cancel restores nothing.
- **Plan size:** about 3,100 tokens, kept as one story.

</frozen-after-approval>

## Code Map

- **Webview** `webview/src/assistant/`:
  - **`AssistantView.tsx`** (221 lines, one component, the whole state in `useState`):
    - keep `QuestionCards` (l.77), `accessPanel()` (l.39) and `answerOf()` (l.65);
    - split the rest into `Transcript.tsx`, `Turn.tsx`, `StepRows.tsx`, `FileRows.tsx`, `Composer.tsx` and `Markdown.tsx` (the Markdown renderer).
  - **`assistant.css`:** `var(--vscode-*)` only, class prefix `rpcn-assistant-*`.
  - **Tests:** `AssistantView.test.tsx`, vitest under happy-dom, with `// @vitest-environment happy-dom` and the `vscodeStub.posted` pattern. Add a test file for each new part.
- **Protocol** `src/shared/assistantProtocol.ts`:
  - **The state message:** `AssistantStateMessage` (l.55). Replace `request`, `progress[]` and `note` with `turns: AssistantTurnView[]`, each holding {id, command, text, skill, steps[], reply, files[], actions[], chips[], outcome}. Keep `access`, `runtime`, `skills`, `skillsProblem`, `status`, `questions` and `error`.
  - **Webview messages:** add `runRequested{command, request}`, `openFileDiff{turn, path}`, `keepTurn{turn}`, `undoTurn{turn}`, `turnAction{turn, action}`, `openLink{href}` and `newConversation`.
  - **Parsers:** update `parseAssistantHostMessage` (l.198) and `parseAssistantWebviewMessage` (l.218).
- **Port** `src/adapters/assistant/host.ts`: `AssistantEvent` (l.37) gains `step`, `stepDone`, `reply{text}` and `fileChanging`. `progress` stays, for system lines such as "Started (model)".
- **Event mapping** `src/adapters/assistant/events.ts`:
  - `progressOf` (l.74) and the `parent_tool_use_id` skip (l.82) become a mapper that emits steps from `tool_use` and `stepDone` from the `tool_result` blocks of user messages (matched by `tool_use_id`), plus the full reply text.
  - Reuse `toolProgress` (l.40) for labels. A summariser table keyed by tool name lives here.
- **SDK adapter** `src/adapters/assistant/agentSdkHost.ts`: in the PreToolUse hook (l.272), take the snapshot for the write tools before returning the decision. That is the first time per path per run, using `fs.readFile` with the 1 MB cap. Keep the PostToolUse `fileWritten` (l.281).
- **The view** `src/adapters/vscode/assistantView.ts`:
  - `event()` (l.553) builds the current turn. `state()` (l.352) maps the turns through `mask()` (l.347).
  - `run()` (l.459) and `runClaimed()` (l.476) take the command. The skill is `rpcn-design` (l.524).
  - The turn's snapshots live in the view; Keep and Undo go there.
  - Undo uses `vscode.workspace.fs` for writes and deletes.
  - `readNote`, `isDesignNote` (l.659) and `askApproval` (l.606) stay as they are.
- **Before-turn documents:**
  - **Pattern:** follow the `registerTextDocumentContentProvider(DEPLOYED_SCHEME…)` provider in `cloudView.ts:737`, the URI builders in `cloudShared.ts:29-54`, and `vscode.diff` as in `cloudDeploy.ts:119`.
  - **Scheme:** a new `rpcn-assistant-before`, served from the view's snapshots.
- **New** `src/shared/lineDiff.ts`: line-level counts of +N and −N (Myers or LCS). It needs no vscode import, and has a mocha unit test.
- **Fake host** `src/test/helpers/fakeAssistantHost.ts`: the `write` step reads the file first and emits `fileChanging`. Add `{step}`, `{stepDone}` and `{reply}` helpers, and update `happyScript()`.
- **Tests:**
  - **Mocha unit tests:** `src/test/adapters/assistant/events.test.ts` for the step, stepDone and reply mapping, and `src/test/adapters/vscode/assistantView.test.ts`.
  - **Integration:** `src/test/integration/suites/99c-assistant.ts`. Keep every existing state test, rewritten against `turns`, and reuse `startRun`, `answerPicks` and `assertNoLeak`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/lineDiff.ts` (+ test) -- the +N/−N counts -- the file rows need them.
- [x] `src/adapters/assistant/host.ts`, `events.ts`, `agentSdkHost.ts` (+ tests) -- the new events, the step pairing, the full reply and the snapshots -- the turn needs the data.
- [x] `src/shared/assistantProtocol.ts` -- the turns and the new webview messages, and their parsers -- one contract.
- [x] `src/adapters/vscode/assistantView.ts` -- build the turns; handle Keep, Undo, the diff, links, New conversation and the before-turn provider; auto-keep on a new Send, and confirm an Undo over later edits -- the host side.
- [x] `webview/src/assistant/*` (+ tests) -- Transcript, Turn, StepRows, FileRows, Composer and Markdown in option A's layout; the states inside the chat; theme CSS -- the view.
- [x] `src/test/helpers/fakeAssistantHost.ts`, `src/test/integration/suites/99c-assistant.ts` -- the scripted turns, and every Matrix row except MD_HOSTILE and SLASH (webview tests), plus a disabled `/build` showing its hint -- proof without a model.
- [x] `CHANGELOG.md`, `README.md` -- the chat view, Keep and Undo.

**Acceptance Criteria:**
- Given a finished design turn in the fake host, when the user clicks the note's file row, then VS Code opens a diff whose left side is empty and whose right side is the note.
- Given two turns, when the second ends, then the first turn's steps fold to one line, and clicking that line opens them.
- Given the full stable suite, when it runs, then every 8.1 and 8.2 state test still passes against the new transcript.

## Implementation Notes

- **Events:** `events.ts`'s `progressOf` became `StreamMapper` (one per run): `step` per top-level `tool_use`, `stepDone` per matching `tool_result` (by `tool_use_id`), `reply` per top-level text block, `progress` only for `init`. The summariser table (`STEP_SUMMARISERS`) has Read, Glob and the write tools for now; 8.4 adds the rpcn tools'.
- **Snapshots:** `src/adapters/assistant/snapshot.ts` (`snapshotOf`) is shared by the SDK adapter's PreToolUse hook and the fake host's `write` step. `fileChanging` gained `tooLarge?: true` (with `before: null`) for files over 1 MB. Snapshots are read as UTF-8 text, so Undo is byte-identical for UTF-8 files only.
- **Protocol additions beyond the Code Map's list:** each turn also carries `review` (`none` | `pending` | `kept` | `undone`), `note` (the design note and its `status`, for Open note and the stage ✓) and `notice` (Undo's error line); the state carries `folder` and `designReady`. Step marks add `info` for the run's own lines ("Started (model)", "Asks to …", "Allowed", "Answered 2 questions").
- **Host seams:** `AssistantViewUi` gained `confirmUndo`, `info` and `openExternal`; the extension API's view exposes `keep`, `undo`, `openFileDiff`, `openLink` and `newConversation` for the suite. `run()` takes the command and returns `disabled` for `/build` and `/test`.
- **Tests:** SUBAGENT is covered by the events unit test (the fake model has no subagent turns); NO_CHANGE and STEP_FAIL also through the real SDK adapter on the fake Messages API.
- **Manual check 1 fixes (2026-11-25):**
  - Step rows sit in a bordered card (radius 6px, 1px lines between rows). `StepRows.stepRows` merges consecutive steps with the same label into one row (`… ×N`, the worst mark of running > failed > ok, the last result). Reads and searches inside the skills copy get one label host-side (`SKILL_READ_LABEL`, from `toolProgress`), and the view shows them as a single row, "Read N skill references".
  - A failed step followed by a later tool row, in a turn that did not end in error, shows a warning mark (`!`, `--vscode-editorWarning-foreground`). The red ✗ stays only on the last step or in an error turn.
  - The user's message has a "You" header (a 22px round avatar and the bold name) and a full-width box. The rpcn header has the 22px sparkle badge (button colours). New conversation is the artboard's "+" icon button (inline SVG, with aria-label and title).
  - The design note's file row shows its status badge (`rpcn-assistant-status-<status>`, styles restored).
  - Once the questions are answered, the host relabels the question's step row "Asked N questions · you kept K picks, answered M" (no separate "Answered" row).
  - Keep without a click: the webview posts `keepTurn` only from the Keep button's `onClick`, and the host's `keep()` is reached only from that message. Auto-keep on a new Send does not log "kept". The log line therefore means a click reached Keep. No autofocus, key handler or form encloses it. The likely cause is a click landing on Keep as it appears at the run's end, when the reply and the file rows push the transcript about. Keep and Undo now take no click for 800 ms after they appear (`SETTLE_ARM_MS`, shown with `aria-disabled`).
- **Manual check 2 fixes (2026-11-25):**
  - Approvals fold into their tool's step row. The SDK adapter passes `canUseTool`'s `toolUseID` as the approval's `stepId`. The decision becomes the step's result when the step has no other short result, and a denied step always shows "denied". A denied step takes the usual failed or warning mark. There are no "Asks to …", "Allowed" or "Denied" rows. An approval with no step to fold into (the fake host) is a single row of its own. The waiting-for-approval row still shows while the modal is open.
  - A shell step's label is "Ran a shell command"; the command (masked, one line, clipped) is the step's new `detail`, shown as a muted second line with a title. Consecutive repeats group ("×N"), and a grouped row is a button (`aria-expanded`) that opens to each step's command, mark and result.
  - The card collapses. While the turn runs it shows the last 6 rows under "… N earlier steps", which opens the rest. Once the turn ends (the latest one too) the card folds to "▸ N steps · W warnings · F failed", which opens on click. A turn that ended in error keeps its rows open.

## Plan Change Log

## Review Triage Log

**Pass 1 (Quick lens):** 6 findings. By verdict: high 0, medium 2, low 3, false 1. By route: 3 patch, 3 rejected.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A file the turn creates over 1 MB, or grows past 1 MB, gets a normal row, a diff and an Undo, and its whole content is kept in memory | medium | patch | `turnFiles` marks `tooLarge` only from the snapshot (`snap.tooLarge`), which is set only when the file was already over 1 MB before the write. The matrix's BIG_FILE says "the turn writes a file over 1 MB". Patch: mark the row `tooLarge` when the content after the turn is over `SNAPSHOT_MAX_BYTES` too (stat it before reading), and add a test for a created 2 MB file. |
| 2 | Undo runs after New conversation has cleared the turn, if New conversation is clicked while Undo's confirm is open | false | rejected | `confirmUndo` is `showWarningMessage(…, { modal: true })`, and a modal blocks the whole window, webview included, so New conversation cannot be clicked while it is open. |
| 3 | A Send during Undo's awaited writes races the new run | low | rejected | The window is the few milliseconds of local `workspace.fs` writes, after the confirm. The fix is a new busy guard across both paths. It is unlikely in everyday use and adds state. |
| 4 | A Send that never starts (the host factory throws) has already kept the previous turn's changes | low | patch | `runClaimed` settles the pending turns before `this.factory(…)`. Patch: move the auto-keep loop to after the host is created. This is a direct reordering with no new state. (A run that ends `runtimeMissing` after it started stays as it is.) |
| 5 | New conversation during a run's start lets the run reach `host.start` before it is stopped | low | rejected | The window is `await access.ready` plus `apiKey()` from secret storage, which is milliseconds. `newConversation` then stops it. The fix is a cancellation token checked after the awaits, which is new state for an unlikely case. |
| 6 | Undo leaves behind the folders a turn created for its new files | medium | patch | `undo()` deletes only the file for `before === null`. A turn that writes `flows/x/a.yaml` into a new `flows/x/` leaves the folder, against UNDO_NEW ("both deleted"). Patch: when the view gets `fileChanging` with `before: null` (synchronously, before the write), record the topmost ancestor folder that does not exist yet (below the workspace). Undo deletes that folder too, recursively, only when it holds nothing but the turn's created files. Add a test with a nested new folder. |

## Verification

**Commands:**
- `npm run compile && npm run test:webview` -- expected: no errors, and every webview test passes.
- `npm run compile-tests`, then `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 900 xvfb-run -a npx vscode-test --label stable --grep "assistant"` -- expected: pass.
- The full stable suite twice, then `--label multiroot` -- expected: all pass. Run one at a time; never `--label floor`.

**Manual checks:**
- The user's check of the look against option A in the dev host, with at most 2 real runs.

### Orchestrator verification (after pass-1 fixes, 2026-11-25)

- `npm run compile` passed; `npm run test:webview` 463/463; `npm run compile-tests` passed.
- Full stable suite run twice: 1915 passing, 1 pending each time. `--label multiroot`: 15 passing. No floor run.
