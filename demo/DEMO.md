# Pipeline Designer for Redpanda Connect: a 15-minute demo

This script walks through the extension's core features in about 15 minutes. Each step has its own folder, `step_<number>_<topic>`, with the pipeline it uses. Every pipeline uses only built-in components (`generate`, `mapping`, `switch`, `log`, `stdout`, `drop`), so the demo needs no Kafka, database or network service except in the optional Cloud step.

| # | Step | Folder | Time |
|---|------|--------|------|
| 1 | Snippets and schema completion | `step_1_snippets` | 2 min |
| 2 | Pipeline graph | `step_2_graph` | 2 min |
| 3 | Lint on save, Quick Fix and live Bloblang errors | `step_3_lint_and_quick_fix` | 2 min |
| 4 | Bloblang test panel | `step_4_bloblang_test_panel` | 2.5 min |
| 5 | Run and Stop | `step_5_run` | 1.5 min |
| 6 | Environment variables and secrets | `step_6_environment` | 2.5 min |
| 7 | Deploy to Redpanda Cloud and Pipeline Logs (optional) | `step_7_cloud_deploy` | 2.5 min |

## Before the demo

- VS Code 1.100 or newer, with this extension and **YAML by Red Hat** installed.
- A Redpanda Connect binary: `rpk` with `rpk connect`, or `redpanda-connect`, on the `PATH` or set in `redpandaConnect.binaryPath`. The status bar shows its version once it is found.
- Open the `demo` folder as the workspace (**File → Open Folder…**), so each step's file is a click away in the Explorer.
- For step 7 only: a BYOC or Dedicated cluster in Redpanda Cloud, a service account that can manage its pipelines, and a Redpanda user that can read the cluster's `__redpanda.connect.logs` topic. Connect the service account before the demo so the step starts at Deploy.
- Close any `*.cloud.json` left from an earlier run of step 7, or delete it, so Deploy starts fresh.

## 1. Snippets and schema completion (2 min)

**File:** `step_1_snippets/blank.yaml` (empty).

1. Open the file and type `rpcn-`. Pick the whole-pipeline snippet: an `input`, a `pipeline` and an `output` that lint clean as they are. Press Tab to move through the placeholders.
2. Under `input:`, start a new line and press Ctrl+Space: the inputs of your binary's version are offered with their descriptions. Do the same on a `processors:` item for the processors.
3. Hover a component or field name: its documentation comes from the binary itself, so it matches your version.

**Say:** the schema is generated from the binary you run, not shipped with the extension, so completion, hover and docs always match the connectors you actually have. Discard the edits afterwards.

## 2. Pipeline graph (2 min)

**File:** `step_2_graph/orders_router.yaml`.

1. Open the file: its graph opens beside the editor. The input `orders`, the `route_by_amount` switch with its two cases, and the `print` output appear as nodes.
2. Move the cursor through the YAML: the node under the cursor is highlighted. Click a node, for example `log_large`: the cursor jumps to its YAML.
3. Edit the YAML, for example add a processor to the second case: the graph follows as you type.

**Say:** the YAML stays the source of truth. The graph is a live view of it, never a second copy to keep in sync.

## 3. Lint on save, Quick Fix and live Bloblang errors (2 min)

**File:** `step_3_lint_and_quick_fix/broken.yaml`.

1. Open the file. Before saving, the mapping `root.double = this.n *` is already underlined: the live Bloblang check reports `expected query, but reached end of input` while you type. Its graph node shows the error marker too.
2. Save (Ctrl+S). Lint runs and reports `field intervall not recognised` and `field levl not recognised` on their lines.
3. Put the cursor on `intervall` and press Ctrl+. : pick **Change to `interval`**. Do the same for `levl` → **Change to `level`**.
4. Fix the mapping, for example `root.double = this.n * 2`, and save: the file is clean.

**Say:** lint is the binary's own `lint`, so the findings are exactly what Redpanda Connect would refuse at start. Discard the edits afterwards (or keep a clean copy).

## 4. Bloblang test panel (2.5 min)

**File:** `step_4_bloblang_test_panel/enrich.yaml`.

1. Click **▷ Test mapping** above the `enrich_order` mapping. The panel opens beside the editor, and its input is already filled from the `generate` input's mapping: a user and two items.
2. With **Run on change** (on by default) the output appears at once: `customer`, the lowercased `email`, `total` (37) and `item_count` (2) in **Content**, and `source: demo` in **Metadata**.
3. Edit the mapping in the YAML, for example add `root.vip = this.total > 30`: the output follows the unsaved text 300 ms after you stop typing.
4. Change the input, for example set a `qty` to 10, or press **Format JSON**. The input is kept as a sample beside the config, so it is there the next time the panel opens.

**Say:** a mapping can be tested on real-looking data without running the pipeline or sending anything anywhere.

## 5. Run and Stop (1.5 min)

**File:** `step_5_run/heartbeat.yaml`.

1. Click the play button in the editor title (**Run**). A terminal named "Redpanda Connect: heartbeat.yaml" opens and prints a heartbeat every second.
2. Click **Stop** in the editor title: the process stops. Run again: the same terminal is reused.

**Say:** Run saves the file first and runs exactly what is on disk, with the same resource files and variables lint uses.

## 6. Environment variables and secrets (2.5 min)

**File:** `step_6_environment/greeter.yaml`.

1. Open the file. `${DEMO_API_TOKEN}` has a yellow Warning: it has no default and no local source sets it, so a local Run would stop on it. `${GREETING:hello}` has none, because it has a default.
2. Click **Run**: it is refused before anything starts, naming `DEMO_API_TOKEN`, with **Set…**.
3. Open the Redpanda Connect icon in the Activity Bar → **Environment**: the config's variables are listed by source, and `DEMO_API_TOKEN` is listed as missing.
4. Put the cursor on `${DEMO_API_TOKEN}`, press Ctrl+. and pick **Set DEMO_API_TOKEN…**. Choose **Secret** and type any value: it is kept in VS Code's secret storage, never in `settings.json`. The Warning goes.
5. Hover `${DEMO_API_TOKEN}`: the hover shows where its value comes from, masked. Run again: it starts, and the log line prints `hello from the environment demo`.
6. Optional: add `GREETING` to `redpandaConnect.env` in the workspace settings, for example `"hi"`, and show the Environment view marking which source wins.

**Say:** the same variable can come from a setting, an env file, a secret or VS Code's environment. The Environment view shows which one wins, and the Warnings catch a missing one before Run does.

Remove the secret afterwards from the Environment view.

## 7. Deploy to Redpanda Cloud and Pipeline Logs (optional, 2.5 min)

**File:** `step_7_cloud_deploy/cloud_hello.yaml`. Needs the cluster and accounts listed under *Before the demo*.

1. Set `DEMO_GREETING` locally (step 6's way), then run **Deploy to Redpanda Cloud** from the editor title.
2. Pick the cluster, give the pipeline a name such as `demo-cloud-hello`, keep the default size.
3. Deploy says the cluster has no secret `DEMO_GREETING`: pick **Keep the value from secret storage**. The secret is created on the cluster, and the config is sent with `${secrets.DEMO_GREETING}` in its place. The value is never shown.
4. Follow the pipeline to **Running** in the **Cloud** view (the Redpanda Connect icon in the Activity Bar). A `cloud_hello.cloud.json` beside the file now maps it to that pipeline.
5. On the pipeline's row, run **Show pipeline logs** (the first time, **Set up log access…** asks for the Redpanda user). The **Pipeline Logs** tab in the bottom panel shows its records, and every fourth message is a simulated `ERROR`. Click the **Info** level chip to hide the info records and keep the errors.
6. Change the config, for example the interval, and run **Deploy to Redpanda Cloud** again: Deploy shows the diff and asks before it restarts the running pipeline. On the pipeline's row in the Cloud view, show **Compare with local file**, then **Stop** and **Delete**.

**Say:** one config goes from the laptop to a managed pipeline without copying YAML by hand, its variables become Cloud secrets, and its errors can be read back in the editor.

Delete the pipeline and the `DEMO_GREETING` secret afterwards.

## After the demo

- Discard the edits to `step_1_snippets/blank.yaml` and `step_3_lint_and_quick_fix/broken.yaml`, so the next demo starts from the same files.
- Remove `DEMO_API_TOKEN`, `DEMO_GREETING` and any `GREETING` setting from the Environment view.
- Delete `step_7_cloud_deploy/cloud_hello.cloud.json` if step 7 ran.
