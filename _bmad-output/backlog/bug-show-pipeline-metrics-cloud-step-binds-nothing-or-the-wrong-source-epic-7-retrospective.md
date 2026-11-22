---
id: 58
type: bug
title: "Show Pipeline Metrics' Cloud step binds nothing, or the wrong source (epic 7 retrospective)"
parent: none
covers: []
after: []
assignee: ""
refined: false
hitl: false
risk: medium
severity: P2
estimate: ""
---

# Show Pipeline Metrics' Cloud step binds nothing, or the wrong source (epic 7 retrospective)

## Description

For a config that is not running but is mapped to a Cloud pipeline, Show Pipeline Metrics, the tab's Show button and the tab's own bind on opening go through Show metrics. Three things go wrong on that step. (a) When Show metrics does not start, the tab stays unbound or keeps a stale source, instead of showing the file as Not running with Run. (b) Before the Cloud view's account node has been expanded in this session, Show metrics says "That pipeline is no longer in the Cloud view" about a pipeline that exists. (c) The bind the tab starts on opening can overwrite a Show or pick the user made meanwhile, and a transient failure blocks the bind from trying again. The user's last choice should win, and a failed Cloud step should end on the file's Not running state.

## Reproduction

(a) A failed Cloud step:
1. Map `metrics_a.yaml` to a Cloud pipeline, then disconnect the service account. Don't run the file.
2. With `metrics_a.yaml` active, run Show Pipeline Metrics.
3. Actual: the "not connected" message, and the tab is unbound (or keeps its previous source). Expected: the message, and then the tab shows `metrics_a.yaml` as Not running with Run.

(b) The cluster list is not loaded:
1. Start a fresh dev host with the account connected, and leave the Cloud view collapsed.
2. With the mapped `metrics_a.yaml` active and not running, run Show Pipeline Metrics.
3. Actual: "That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again." Expected: the pipeline's metrics. After expanding the account node, the same command works.

(c) The bind on opening races with the user:
1. With a mapped, not-running config active, open the Pipeline Metrics tab. While its bind is waiting on Show metrics, pick a running file from the pick (or run Show Pipeline Metrics on another file).
2. Actual: the tab ends on the mapped Cloud pipeline. Expected: it ends on what the user chose.
3. Separately: open the tab while signed out (the bind fails), connect, and reveal the tab again. Actual: no new bind is tried for that config. Expected: it binds the mapped pipeline.

## Cause Hypothesis

(a) The panel's mapped step reports success whenever a mapping exists, whatever Show metrics returns, so the resolver never reaches its last step. Show metrics already returns whether it started. (b) Show metrics loads a cluster's pipelines when the cluster is held, but nothing loads the cluster list, which loads only when the account node is expanded or on Connect. (c) `stillWanted` is checked once, before the Cloud command's awaits, and the once-per-config guard is set before the attempt and never cleared on failure. The unit fake for `executeCommand` only records the call, so no test runs the real Show metrics through the resolver.

## Acceptance Criteria

1. **A failed Cloud step ends on the file's Not running state**
   **Given** a config mapped to a Cloud pipeline, not running, and Show metrics cannot start for it (not signed in, pipeline gone, no Prometheus endpoint, the access pick cancelled)
   **When** Show Pipeline Metrics, or the tab's Show button, is used on it
   **Then** Show metrics' own message is shown, and the tab shows that file as Not running with Run
2. **Show metrics finds a mapped pipeline before the Cloud view is expanded**
   **Given** a connected account whose cluster list has not been loaded in this session, and a pipeline that exists on it
   **When** Show metrics is asked for that pipeline (from the command, the tab's opening or its Show button)
   **Then** it loads what it needs and shows that pipeline's metrics; it says the pipeline is gone only when the loaded cluster or pipeline list does not contain it
3. **The user's last choice wins over the tab's bind on opening**
   **Given** the tab's bind on opening is still waiting on the Cloud step
   **When** the user shows another source meanwhile (the command, the pick, a Show button)
   **Then** the tab ends on the user's source, not on the mapped pipeline
4. **A failed bind on opening can try again**
   **Given** the tab's bind on opening failed for a config because of a state that can change (signed out, cluster not readable)
   **When** that state changes and the tab is revealed again with the same config active
   **Then** the bind is tried again, and a failure that repeats its message is still not shown on every reveal
5. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers each of (a), (b) and (c), through the real Show metrics command rather than the fake that only records the call
6. **Or: no change is needed, with proof**
   **Given** the reproductions
   **When** they are run on the current code
   **Then** the expected behavior already holds, with the evidence recorded in Notes — this supersedes 1 to 5

## References

- parent — none
- source — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/epic-pipeline-metrics-retrospective.md`, Findings C1, C2, C3; action item AI-1
- related — `_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/story-entry-points-for-metrics-plan.md` (7.9, the resolver order)

## Notes

- Decision: a failed Cloud step falls through to the file's Not running state, as the 7.9 resolver order says; this answers the retrospective's open question on AI-1 (user, 2026-11-21).
- Decision: risk medium, severity P2: it changes the shared resolver and the command ordering, and expanding the Cloud view first works around (b) (user, 2026-11-21).
- Open question: for (c), which failures count as transient for a retry (signed out, cluster not readable), and which stay once per config (no Prometheus endpoint).
