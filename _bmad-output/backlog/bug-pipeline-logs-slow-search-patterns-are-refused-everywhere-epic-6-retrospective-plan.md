---
title: 'Pipeline logs: slow search patterns are refused everywhere'
type: 'bugfix'
ticket: '54'
created: '2026-11-13'
status: 'done'
baseline_revision: '5a57dce6b20eb2f8aa5b0fb89acf15c374ef327f'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Pipeline Logs search refuses only quantified groups holding a quantifier or an alternation (`slowPattern`), so ungrouped adjacent unbounded quantifiers such as `.*.*.*x` or `\w+\w+x` pass and backtrack polynomially on the extension host on values near the 10,000-character match limit. The webview's highlight runs the search's global pattern on the full row text with no length cap, so it can freeze the webview on a long message.

**Approach:** Extend the shared static check so it also refuses the slow ungrouped shapes, with the same message, at the box and on the host; cut the text the webview highlights to the host's `MAX_MATCH_CHARS`. No new dependency.

**Decision (user, 2026-11-11):** split from bug 51 as its group C; no floor (VS Code 1.100.0) runs (user).

**Decision (user, 2026-11-13, the recommended option):** a static check, no time budget. The new rule refuses two unbounded quantifiers on broad atoms (`.`, `\w` `\W` `\s` `\S` `\d` `\D`, any `[...]`, a group) when nothing required separates them, at any depth (`.*.*x`, `\w+\w+`, `.*\d+x`, `\d+[a-z]+`); a required literal between them, as in `error.*timeout.*retry`, keeps the pattern accepted.

**Decision (2026-11-13, superseding the one above; the user's standing instruction that day: "Do not ask me for approval, use the recommendation if I have to make a decision"):** the review showed the decision above rested on a wrong claim: a required literal between two broad repeats does not bound the backtracking (`.*a.*a.*b` took over 30 s on 1,000 characters), ungrouped repeats on plain literals (`a*a*x`) and chained bounded repeats (`.{1,100}.{1,100}.{1,100}x`) are slow too, and classes that cannot overlap (`\w+\s+\w+`) are fast. The rule is now set-based: two repeats whose atoms can match a common character, with nothing required between them that neither can match, are refused. Still a static check, no time budget, no new dependency. So `error.*timeout.*retry` (two `.*`) is now refused, and `\w+\s+\w+`, `\d+\s*ms`, `[A-Z]+\s+[0-9]+`, `\d+[a-z]+` and `a+b*` are accepted.

## Boundaries & Constraints

**Always:** One rule in `src/shared/logsProtocol.ts`, used by the host filter and the webview alike; the refusal message stays `SLOW_PATTERN_ERROR`; the 6.4 accepted patterns stay accepted and the refused ones refused; plain-text search is never refused.

**Never:** A new dependency, a worker or a timer around matching; changing plain-text search, Match case, the field filter, the level chips, bug 51 group A's reading, or what the host matches against (still the first `MAX_MATCH_CHARS` of each value).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OVERLAP | regex `.*.*.*x`, `\w+\w+x`, `.*\d+x`, `\s*.*`, `a*a*x`, `.*a*x`, `.*a.*a.*b`, `error.*timeout.*retry`, `.{1,100}.{1,100}.{1,100}x`, `(?<n>.*)\k<n>x`, `(a).*\1+` | refused at the box and on the host, `SLOW_PATTERN_ERROR`; nothing matched | the filter is not posted / not applied |
| NESTED | `(a+)+`, `(a|aa)*` and the 6.4 refused list | refused, as today | — |
| ACCEPTED | anchors, classes, single quantifiers, `?`, `\d{1,3}`, `.{1000}`, `error.*timeout`, `a+b*`, `\w+\s+\w+`, `\S+\s+\S+`, `\d+\s*ms`, `[A-Z]+\s+[0-9]+`, `\d+\.\d+` and the 6.4 accepted list | accepted, match as today, and each finishes in well under a second on 10,000-character worst-case values | — |
| PLAIN | plain text `.*.*x` (regex off) | searched literally | — |
| HIGHLIGHT_CAP | accepted pattern, a value longer than `MAX_MATCH_CHARS` | matches marked only in the first `MAX_MATCH_CHARS`; the rest shown unmarked and whole | — |

</frozen-after-approval>

## Code Map

- `src/shared/logsProtocol.ts` -- `SLOW_PATTERN_ERROR` :114, `MAX_MATCH_CHARS` :116, `quantifierAt` :125, `repeatsAt` :126, `slowPattern` :122-163 (character scanner: skips escapes and `[...]`, a stack of open groups marked when they hold a quantifier or `|`; refuses a marked group followed by `*`, `+`, `{n,}`/`{n,m}`; ignores quantifiers outside groups, the defect), `searchPattern` :169-182 (only caller; flags `g` when global, `i` unless Match case), `searchError` :185, `parseLogFilter` :584.
- `src/adapters/logs/filter.ts` -- `compileFilter` :28-34 (refused → undefined), `matches` :37-54 (cuts each of message, level, instance, field keys and values at `MAX_MATCH_CHARS` :52). Unchanged.
- `webview/src/logs/LogsView.tsx` -- imports from `../../../src/shared/logsProtocol` :45-50; `highlightParts` :119-141 (loops `re.exec` on the whole text, the defect); `Highlighted` :143; `marks` memo :546-549 builds the global pattern via `searchPattern`; `FilterBar` :183 shows `searchError`; `sendFilter` :516.
- Tests: `src/test/adapters/logs/filter.test.ts` SLOW :52-63 (refused :53, accepted :60), cap :65-70, CASE_REGEX :41 (`'^Input .* active$'`); `webview/src/logs/LogsView.test.tsx:433` highlightParts. Run: `npm run test:webview`; unit tests through `--label stable`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/logsProtocol.ts` -- replace `slowPattern`'s logic with one tokenizer and the set-based rule in Design Notes (the nested-group rule kept as a case of it, on the same tokens); update the doc comments -- C12 host and box.
- [x] `webview/src/logs/LogsView.tsx` -- `highlightParts` runs the pattern only on the first `MAX_MATCH_CHARS` of the text and appends the rest as one unmarked part -- C12 webview (KEEP: the first pass's change, see Plan Change Log).
- [x] `src/test/adapters/logs/filter.test.ts` -- the OVERLAP refusals and the ACCEPTED cases (box via `searchError`, host via `compileFilter` and `parseLogFilter`); the 6.4 lists unchanged; a timing test: every accepted pattern of the 6.4 and new lists runs on 10,000-character worst-case values (runs of `a`, ` `, `1`, `x`, `ab`, mixed `aA1 _-.`, and the pattern's own literal characters repeated) and each finishes under 1 s -- criterion 4.
- [x] `webview/src/logs/LogsView.test.tsx` -- a highlight test on a value longer than `MAX_MATCH_CHARS` (marked before the cap, unmarked past it, a match across the cap unmarked, the parts join to the whole text); a refused pattern gives no highlight pattern (`searchPattern` returns an error for `.*.*x`) -- criterion 4.
- [x] Show each new test fails on the baseline code and passes on the fix; record it in Implementation Notes.

**Acceptance Criteria:**
- Given the matrix rows, when the unit and webview tests run, then each row is covered and passes.
- Given compile with lint, corpus, webview, stable and multi-root runs, when they run, then all pass.

## Implementation Notes

- `slowPattern` is now `nestedRepeats(source) || adjacentBroadRepeats(source)`: the old scanner kept as `nestedRepeats` unchanged; the ADJACENT rule is a second linear scanner in the same file (`adjacentBroadRepeats`, with `quantifierOf` and `MAX_BOUNDED_REPEAT = 100`). One exported check, used by `searchPattern`, so the box (`searchError`) and the host (`compileFilter`, `parseLogFilter`) refuse alike with `SLOW_PATTERN_ERROR`.
- The scanner keeps one flag, "an unbounded broad quantifier came after the last required item"; a required literal (no quantifier, or a minimum of 1 or more) clears it; anchors, `\b`, optional literals and unquantified broad atoms leave it. Groups keep a frame: `|` restarts from the flag at the group's open, `)` takes the OR of the alternatives' ends. A group repeated without bound is a broad atom (refused when the flag is still set through its content, or for a minimum of 0 when set at its open). A lookaround is zero-width (the flag after it is the one at its open). A bounded repeat of 2 or more (`(.*){2}`) is refused when the content starts with a broad repeat before any required item and ends with one pending. Back-references count as broad atoms.
- Judgement calls (conservative, per "two broad atoms are treated as overlapping"): `(ab)+.*` and `.*(?=x).*` are refused; `.*(ab)+` is accepted (its content is a required literal).
- `highlightParts` runs the pattern on the first `MAX_MATCH_CHARS` only; everything after the last match (the unsearched rest included) is one unmarked part, so a match straddling the cap is not marked and the parts always join to the whole text.
- Baseline check: with only the new tests applied on 5a57dce, the new SLOW test failed (`.*.*.*x`: false !== true, mocha on `out/test/adapters/logs/filter.test.js`) and the new highlight test failed (a second `needle` past the cap was marked); both pass with the fix.
- Verification: `npm run compile` (types, lint, build), `npm run test:corpus` (182 passed), `npm run test:webview` (382 passed), `vscode-test --label stable` (1493 passing, 1 pending, 0 failing) and `--label multiroot` (15 passing) under xvfb. No floor run (user decision).
- **The notes above are the first pass, reverted at review loop 1 (see Plan Change Log).**

Second pass (after review loop 1):
- `slowPattern` in `src/shared/logsProtocol.ts` is one tokenizer (`regexItems`: items of atoms with a `CharSet` — ASCII bitset plus a non-ASCII bit, letters folded to both cases after any negation —, assertions, groups and lookarounds, with their quantifiers) and one walk (`walk`/`step`/`repeatStep`) following Design Notes; it throws an internal `Refused`. The 6.4 nested rule is a case of the walk on the same items (`repeatsGroup` + `holdsVariation`), kept as broad as the old scanner: a group under `*`, `+`, `{n,}`, any `{n,m}` but `{0,1}`, or `{n}` with n ≥ 10 that holds any quantifier or `|` at any depth.
- Deviation from Design Notes (taken, per the standing instruction, on measured evidence): a bounded range counts as a repeat from m − n ≥ 2, not ≥ 10. With ≥ 10 a random fuzz of 4,000 patterns the rule accepted found many over 1 s on 10,000-character values (e.g. `[a-z]{2,}a{0,9}\w{0,9}a\d?Z` 17 s, `.?\w+[^x]?(a|b)[a-z]{0,9}\s{1,20}Z` 8.5 s, `\d*.{0,9}Z` 1.5 s); with ≥ 2 a fuzz of 2,500 found none over 0.77 s. `\d{1,3}`, `\d{1,3}\.\d{1,3}` and `.{1000}` stay accepted (nothing before them meets them); `?`, `{n}` and `{n,n+1}` are still not repeats.
- Refinements within the rule: a back-reference is a repeat (so `(?<n>.*)\k<n>x` and `(a).*\1+` are refused, `(\w+)\s\1` accepted); a quantified group that is not a repeat (`(…)?`, `(…){2}`, `(…){1,2}`) is walked in place (twice when it can repeat; its start joined in when optional) as well as on its own, so `(.*)?.*x` and `(a*){5}x` are refused. `(?i:` and the other inline modifiers are read as a plain group prefix (Node 22 rejects them as invalid anyway, so the compile reports that).
- `highlightParts` (KEEP): the pattern runs on the first `MAX_MATCH_CHARS`; everything after the last match is one unmarked part; doc comment worded "A match that crosses the cap is not found or marked, as on the host".
- Tests: `filter.test.ts` gains the OVERLAP list (refused via `slowPattern`, `searchError` with and without Match case, `compileFilter`, `parseLogFilter`; plain text never refused, `.*.*x` searched literally) and the ACCEPTED list (the 6.4 accepted list plus the matrix's), and a timing test over every accepted pattern on 10,000-character runs of `a`, ` `, `1`, `x`, `ab`, `aA1 _-.` and the pattern's own literals (each value under 1 s; the whole test about 1.3 s). The 6.4 SLOW tests are unchanged. `LogsView.test.tsx` gains a highlight test past the cap (marked before, a match across the cap unmarked, a match ending at the cap marked, parts join to the whole) and a refused `.*.*x` giving `{ error: SLOW_PATTERN_ERROR }` while plain `.*.*x` is a RegExp.
- Baseline check (new tests on 5a57dce code, by stashing the two source files): the new refusal test failed (`.*.*.*x`), the new highlight test failed (5 parts instead of 2); both pass with the fix. The timing test passes on the baseline too, by design: it runs the accepted lists, which the baseline also accepted and which are fast; it guards against a future rule change making them slow, not against the defect.
- Verification: `npm run compile` (types, lint, build) exit 0, `npm run test:corpus` (182 passed), `npm run test:webview` (382 passed), `vscode-test --label stable` (1494 passing, 1 pending, 0 failing) and `--label multiroot` (15 passing) under xvfb. No floor run (user decision).
- Residual risk: the rule is a heuristic; single unbounded repeats with a failing suffix are inherently quadratic (up to about 0.5–0.8 s worst case on 10,000 characters, e.g. `([a-z]*(a|b)?)?Z`), and chains of `?` after a repeat (`.*a?a?a?…`) are not counted. Over-refusal is conservative: letters fold regardless of Match case (`[A-Z]+[a-z]+` refused), and `(ab)+.*` / `.*(ab)+` are both refused.

Second pass, review round 2 (coordinator's findings):
- Repeats for the overlap walk are now every quantified item whose count can vary (max > min: `?`, `{n,n+1}`, small ranges) plus back-references, replacing m − n ≥ 2 above; so `.*a?a?a?a?a?a?b`, `a?`×18 `a`×18 `b`, `a{1,2}`×16 `b` and `(a|a)?`×18 `b` are refused. The 6.4 nested rule (`repeatsGroup` + `holdsVariation`) is unchanged, so `(a+)?` and `fail(ed)?` stay accepted.
- Character sets: the one non-ASCII bit became two kinds (non-ASCII spaces, other non-ASCII), each with a "some" and an "all" bit, so a complement is exact: `\S`, `[^é]`, `[^\s]` keep the other non-ASCII characters (`\S+[^\x00-\x7f]+x`, `[^é]+ü+x` refused) while `\S+\s+\S+` stays accepted. A negated class is folded before it is complemented, so `[^a-z]+[a-z]+` and `[^a]+a+x` are accepted.
- A lookaround's content is walked from the current P (P unchanged after it): `\w+(?=.*x)`, `(?=.*.*x)`, `(?!\w+\w+x)` refused.
- A `{n}` group is walked in place only (twice for n ≥ 2), without the extra walk from ∅; walks are memoised per (group, P) and `charsIn` per group, so checking is linear in practice (a 1,000-character nested `(…)?` or `(?:…){2}` in under 100 ms, tested).
- `slowPattern` catches everything: `Refused` or a `RangeError` (nested too deep) is refused, any other error returns false so `new RegExp` reports it; `searchPattern` no longer throws on `[a`, `a)`, `a\`, `(`, `(?<n`, `\k<` or 50,000 nested parentheses (tested).
- `\N` is a back-reference only when N ≤ the number of capturing groups, else an octal escape (`\8`, `\9` the digit); `\k<…>` only when a named group exists. `\d+\1` (no group) is accepted.
- Tests: the OVERLAP and ACCEPTED lists gained the coordinator's cases; the timing test gained a run of `é`; a new nesting and malformed-input test. `filter.test.ts` 15 passing (mocha on `out/`), `LogsView.test.tsx` 51 passed. Full verification is run by the coordinator.
- Residual, found by fuzz this round: a group of alternatives that can match the same text, under `{n}` after an overlapping repeat (`a+[^x](a|a){2}é{1,3}Z`, 1.6 s on 10,000 characters), is accepted; alternations are not weighed by the rule.

## Plan Change Log

- **2026-11-13, review pass 2 (patch round, no loopback).** Trigger: `?` and `{n,n+1}` chains accepted and slow (`.*a?a?a?a?a?a?b` 8.8 s; `(a|a)?` chains over 10 s on 22 chars); `\S` and negated classes losing the non-ASCII bit; `\w+(?=.*x)` accepted (lookaround walked from empty); the checker exponential in nested fixed-count groups. Amended Design Notes (the repeat definition for the overlap walk, the complement, lookarounds, the checker's own cost). Known-bad state avoided: a guard that itself blocks the host, and exponential chains passing. KEEP: the tokenizer and walk; the 6.4 nested rule's own definition; the highlight cap.

- **2026-11-13, review loop 1 (intent gap, resolved by the user's standing instruction to take the recommended option).** Trigger: the review found the "a required literal between keeps it accepted" rule both too weak and too strict: `a*a*x`, `.*a*x`, `.*a.*a.*b` and chained `.{1,100}` repeats are accepted and slow (seconds to over 30 s), while `\w+\s+\w+`, `\d+\s*ms` and `[A-Z]+\s+[0-9]+` are refused though fast. Amended: the frozen decision (superseded, recorded), the matrix, the tasks, Design Notes (the set-based rule, one tokenizer) and a timing test; Verification added. Known-bad state avoided: a refusal rule asserted on lists only, that misses repeated literals and bounded chains and treats every pair of classes as overlapping. KEEP: `highlightParts` runs the pattern on the first `MAX_MATCH_CHARS` and appends the rest as one unmarked part (the parts join to the whole text; a match across the cap is not marked), with its webview test, its comment worded "a match that crosses the cap is not found or marked, as on the host"; the 6.4 refused and accepted lists in `filter.test.ts` unchanged; refusals asserted through `slowPattern`, `searchError`, `compileFilter` and `parseLogFilter`; plain text `.*.*x` searched literally. The first pass's code was reverted.

## Review Triage Log

Review pass 1 (2026-11-13; blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Verdicts: 3 high, 2 medium, 6 low, 1 false; routed as one intent gap (the rule), resolved by the user's standing instruction, then re-derived; the rest carried into the re-derivation or rejected.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 1 | BH | Repeats on plain literals pass: `a*a*x`, `a+a+$`, `.*a*x`, `x*x*x*y` | high | intent_gap | Measured 3.5 s on 3,000 chars, over 90 s on 10,000; the literal case was outside the "broad atom" rule. Set-based rule. |
| 2 | EC | A literal that the broad atom also matches does not separate: `.*a.*a.*b` | high | intent_gap | Over 30 s on 1,000 chars; the user's decision rested on the claim that a literal bounds it. Superseded decision. |
| 3 | BH, EC | Chained bounded repeats pass: `.{1,100}.{1,100}.{1,100}x` | high | intent_gap | 31 s on 10,000 chars; bounded ranges count as repeats when m − n ≥ 10. |
| 4 | BH, VG | Over-refusal of disjoint classes: `\w+\s+\w+`, `\d+\s*ms`, `[A-Z]+\s+[0-9]+` | medium | intent_gap | Fast patterns refused; sets now computed. |
| 5 | BH | No test measures matching time | medium | bad_plan | A list-only test let 1–3 through; timing test added to the plan. |
| 6 | VG, BH | Back-references and escape branches untested; `(?<n>.*)\k<n>x` accepted (337 ms on 3,000) | low | bad_plan | In the OVERLAP row now. |
| 7 | EC | Inline modifier `(?i:` read as literals | low | bad_plan | In the tokenizer now. |
| 8 | EC | `(ab)+.*` refused while `.*(ab)+` accepted; `.{1000}.{1000}` refused | low | bad_plan | The set rule decides both by sets; `{n}` is not a repeat. |
| 9 | BH | Two parsers (`nestedRepeats`, `adjacentBroadRepeats`) disagree | low | bad_plan | One tokenizer now. |
| 10 | BH | Highlight test comment says a match across the cap is partly marked | low | KEEP note | Rewording carried in the Plan Change Log. |
| 11 | BH | No webview test that a refused pattern gives no highlight | low | bad_plan | Added to the tasks. |
| 12 | BH | `slowPattern`'s doc presents `\d+[a-z]+` as slow | false | reject | Superseded: the new rule accepts it. |

Review pass 2 (2026-11-13, on the re-derived code; same four lenses). Verdicts: 4 high, 3 medium, 6 low (3 patched, 3 rejected), 0 false. Routes: 10 patch, 0 defer, 0 loopback.

| # | Lens | Finding | Verdict | Route | Evidence / action |
|---|------|---------|---------|-------|-------------------|
| 13 | IA, BH, EC | `?` and `{n,n+1}` chains not counted: `.*a?a?a?a?a?a?b`, `a?`ⁿ`a`ⁿ`b`, `a{1,2}` chains, `(a|a)?` chains | high | patch | Measured 8.8 s, 5.2 s on 200 chars, over 10 s on 22 chars. Overlap walk counts any variable count as a repeat. |
| 14 | BH | `complement` drops the non-ASCII bit: `\S+[^\x00-\x7f]+x`, `[^é]+ü+x` accepted | high | patch | 3.7 s and 4.0 s on 3,000 chars. Keep the bit. |
| 15 | EC | Lookaround content walked from empty: `\w+(?=.*x)` accepted | high | patch | Over 20 s on 10,000 chars. Walk from the current P. |
| 16 | BH, EC | The checker is exponential in nested fixed-count groups | high | patch | 728 ms at 15 levels; runs on every keystroke, before any refusal. Walk each group a bounded number of times; timing test on the checker. |
| 17 | BH, EC | A RangeError from deep nesting escapes `searchPattern` | medium | patch | No try around `slowPattern`. Catch: overflow refuses; malformed input left to `new RegExp`. |
| 18 | VG | Case folding, lookaround content and escape decoding can be removed with every test green | medium | patch | Mutations shown by the lens; patterns added to OVERLAP. |
| 19 | EC | Negated class folded after complement: `[^a-z]+[a-z]+`, `[^a]+a+x` refused though disjoint | medium | patch | Fold before complement. |
| 20 | EC | `\N` with fewer than N groups read as a back-reference: `\d+\1` refused | low | patch | Non-u mode reads it as an escape. |
| 21 | BH | Timing test values ASCII only | low | patch | A 10,000 `é` run added. |
| 22 | BH | Malformed and deep-nesting inputs untested | low | patch | Tests added with 17. |
| 23 | BH | Harmless trailing `.*` (`\s*.*`, `(ab)+.*`) and everyday `key=.*id=\d+` refused; message gives no hint | low | reject | The superseding decision accepts refusing two overlapping repeats; telling a trailing repeat apart adds a failability analysis; the message is fixed by the Boundaries. |
| 24 | BH | Single-character alternation groups `(a|b)*` could be read as classes | low | reject | An improvement over the 6.4 rule, not a defect; adds a branch. |
| 25 | BH | Highlight test lacks a regex and a Match case variant at the cap | low | reject | The cap is a slice before the pattern runs; flags do not reach it. |

Intent-alignment notes, pass 2 (descriptive): the separator reading is "the pending repeats cannot match it" (the Design Notes), not the literal "neither"; the repeat threshold was lowered by the implementer and recorded; letters fold whatever Match case; box and host share `searchPattern`; the highlight is per value, as on the host.

Intent-alignment notes (descriptive): the first pass implemented the literal reading with extensions (bounded threshold 100, back-references, `(.*){2}`); its tests asserted lists only and never measured time; box and host share `searchPattern` (holds by construction); the highlight cap is reading C1 (run on the cut, show the whole text).

## Design Notes

**Tokens.** One tokenizer over the source (no `u` flag; letters folded to both cases, conservatively): escapes (`\d \D \w \W \s \S`, `\t \n \r \f \v \0`, `\xNN`, `\uNNNN`, `\cX`, `\b \B` zero-width, `\1`-`\9…` and `\k<name>` back-references, any other escaped character as itself), classes `[...]` with ranges, escapes and `^`, `.`, groups (`(`, `(?:`, `(?<name>`, inline modifiers such as `(?i:`), lookarounds `(?=`, `(?!`, `(?<=`, `(?<!`, `|`, anchors, and quantifiers `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each optionally lazy.

**Sets.** Each atom has the set of characters it can match: a bitset over ASCII 0–127 plus one "non-ASCII" bit; a complement always keeps the non-ASCII bit (the safe side), and a negated class is folded before it is complemented. The checker walks each group a constant number of times, and a stack overflow in it counts as refused. A literal is its character (both cases for a letter); `\d`, `\w`, `\s` and their complements as defined; `.` and a back-reference: everything; a group: the union of every atom inside. Two sets overlap when they share a bit.

**Repeats.** For the overlap walk, a quantified item is a *repeat* when its count can vary (max > min: `*`, `+`, `?`, `{n,}`, `{n,m}`); `{n}` is not. The 6.4 nested rule keeps its own definition (a group repeated without bound, or over a large range, holding a repeat or `|`), so `(a+)?` and `fail(ed)?` stay accepted. (Review pass 2: the first wording, m − n ≥ 10, let `?` and `{n,n+1}` chains through; the implementer had already lowered it to m − n ≥ 2.)

**The rule.** Walk each sequence (the pattern's, a branch's, a group's) keeping P, the union of the sets of the repeats since the last separator:
- a repeat with set R: refused if R overlaps P; otherwise P := P ∪ R when its minimum is 0, and P := R when its minimum is 1 or more (it is required, and since R cannot meet P, P's repeats cannot cross it);
- a required non-repeat item with set S (a literal, a class, `\d{1,3}`, `x{n}`): a separator when S does not overlap P (P := ∅); otherwise P is unchanged;
- an anchor, `\b`, a lookaround: P unchanged (a lookaround's content is walked from the current P, since it runs where it stands);
- a group without a quantifier: each alternative walked from the current P; after it P is the union of the alternatives' ends;
- a quantified group: its content checked on its own from P = ∅; a repeat group whose content holds a repeat or `|` is refused (the 6.4 rule); then the group is one item with its content's set, as above.

So `\w+\s+\w+` is accepted (`\s` and `\w` cannot meet), `.*a.*b` is refused (`a` is in `.`), `a*a*x` is refused, `.{1,100}.{1,100}` is refused, `.{1000}` and `\d{1,3}\.\d{1,3}` are accepted. The timing test is the safety net for what the rule lets through.

## Verification

**Commands:**
- `npm run compile` -- expected: exit 0 (lint included)
- `npm run test:corpus`, `npm run test:webview` -- expected: pass
- `env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT=x11 timeout -k 15 1500 xvfb-run -a npx vscode-test --label stable` -- expected: 0 failing
- same with `--label multiroot` -- expected: 0 failing

**Result (2026-11-13, after review pass 2's patches, run by the orchestrator):** compile (lint included) 0, corpus 182, webview 382, stable 1495 passing, 1 pending, 0 failing (12 min), multi-root 15 passing; the test settings clean; no floor run. Residual risk deferred: alternatives matching the same text under a fixed count after an overlapping repeat (`a+[^x](a|a){2}é{1,3}Z`, about 1.6 s on 10,000 characters).
