---
id: 38
type: story
title: "The Redpanda Connect Enterprise license is documented and its state shown"
parent: none
covers: []
after: [31]
assignee: ""
refined: true
hitl: false
risk: low
estimate: ""
---

# The Redpanda Connect Enterprise license is documented and its state shown

## Description

Enterprise connectors need a Redpanda Enterprise Edition license that covers Redpanda Connect; without one they fail with "this feature requires a valid Redpanda Enterprise Edition license…". The binary finds a license by itself: the `REDPANDA_LICENSE` string, else the file in `REDPANDA_LICENSE_FILEPATH`, else `/etc/redpanda/redpanda.license`. The extension already passes its merged environment to every command, so all three work today, but nothing says how to set them up in VS Code, and nothing shows whether a license loaded: the binary reports it only in a `run`'s startup log ("Successfully loaded Redpanda license … expires_at=… license_type=…", or "Failed to read Redpanda License … error=…").

When this is done, the README explains the setups that fit the extension (the license string as a secret variable, a file path as a plain variable, the default file), and the user can see, for the active config's environment, whether the binary loads a license, its type and expiry, or why it does not.

## Acceptance Criteria

1. **The setups are documented**
   **Given** the README
   **When** a user looks for how to use an enterprise license
   **Then** it gives the binary's order (`REDPANDA_LICENSE`, `REDPANDA_LICENSE_FILEPATH`, the default file) and how to set each in the extension: the string as a secret variable (`redpandaConnect.secretEnv`), a file path as a secret variable or in VS Code's environment, the default file needing nothing; and it says that `redpandaConnect.env` and the env file do not set the license (the binary reads it before its env files)
2. **A loaded license is shown**
   **Given** a config whose environment gives the binary a valid license
   **When** the user looks at its license state
   **Then** it says a license loaded, its type and its expiry date, and where it came from (the variable or the file); the organisation id is not shown
3. **A license that fails is shown with the reason**
   **Given** a license string or file the binary cannot read or validate
   **When** the user looks at its license state
   **Then** it says no license loaded and gives the binary's reason
4. **No license**
   **Given** no license source
   **When** the user looks at its license state
   **Then** it says none is set and links the README section; enterprise connectors are named as what needs one
5. **No secret leaks**
   **Given** any license state
   **When** it is shown or logged
   **Then** the license string never appears in clear: not in the view, a message, a log line, argv or a file the extension writes
6. **Nothing else changes**
   **Given** lint, Run, the live Bloblang check and the test panel
   **When** they run
   **Then** their argv and environment are as today (the extension never passes `--redpanda-license`)

## Boundaries

- Must not change: how variables reach the commands (tickets 29 and 30), their precedence, or the binary's own license lookup.
- No `--redpanda-license` flag from the extension (its value would show in argv).

## References

- parent — none
- related — _bmad-output/backlog/story-an-environment-view-shows-each-configs-variables.md (ticket 31: the Environment view, a likely place for the state)
- related — _bmad-output/backlog/story-secret-environment-variables-kept-in-the-secret-storage.md (ticket 30: secrets and masking)
- docs — https://docs.redpanda.com/connect/get-started/licensing/ (lookup order, the error, the log line)

## Notes

- Probed 2026-10-29 on 4.100.0 and 4.112.0: no license subcommand; `run` logs `level=info msg="Successfully loaded Redpanda license" expires_at=… license_org=… license_type=enterprise`, or `level=error msg="Failed to read Redpanda License" error="…"` (an invalid string: "validating license: failed to split license contents by delimiter"; a missing file: "reading license file: open …: no such file or directory"); `lint` logs nothing about the license. The developer's machine has a license at `/etc/redpanda/redpanda.license` (usable for the manual check).
- Decision (user, 2026-10-29): the state shows in a License group of the Environment view, beside the variables it reads.
- Decision (user, 2026-10-29): it is read on demand (a Check license action), by a tiny `run` with the active config's environment, and the last result stays until checked again; no background runs.
- Decision (user, 2026-10-29): only the type and expiry are shown; `license_org` is left out.
- Decision (user, 2026-10-29, during the build): the binary ignores both license variables from an `--env-file` (probed on 4.100.0 and 4.112.0); a license is set as a secret or in VS Code's environment, and the setting or env file get a warning row instead.
- Open question: on Windows (story 1) the default file path differs; out of scope until then.
