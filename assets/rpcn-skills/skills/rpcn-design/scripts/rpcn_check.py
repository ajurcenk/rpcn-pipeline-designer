# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""rpcn_check: the only code that runs `rpk connect` (AD-2, AD-4).

Every subcommand prints one JSON envelope (schema 1, see SCHEMA.md) and exits
0 when ok, 1 when a check failed, 2 for a usage or environment error.

Canonical source: tools/shared/rpcn_check/rpcn_check.py. Copies inside
skills/*/scripts/ must stay byte-identical; edit the source, never a copy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SCHEMA_VERSION = 1
PLUGIN_VERSION = "0.1.0"
REFS_VERSION: str | None = None  # set by the release stamp once references exist
MIN_VERSION_STR = "4.100.0"
VERSION_TIMEOUT_S = 10
LINT_TIMEOUT_S = 60
LINT_ARGS = ("lint", "--deprecated", "--skip-env-var-check")  # fixed by AD-4

EXIT_OK = 0
EXIT_CHECK_FAILED = 1
EXIT_ENV = 2

INSTALL_HINT = (
    "Install rpk (https://docs.redpanda.com/current/get-started/rpk-install/) and run "
    "`rpk connect install`, or put a `redpanda-connect` binary on PATH, or set "
    "RPCN_BINARY to its path."
)

_VERSION_RE = re.compile(r"^\s*Version:\s*v?(\d+)\.(\d+)\.(\d+)(\S*)\s*$", re.MULTILINE)
# Greedy file part: a path containing parentheses still splits on the last `(line,col)`.
_LINT_LINE_RE = re.compile(r"^(?P<file>.+)\((?P<line>\d+),(?P<col>\d+)\) (?P<message>.*)$")
_GLOB_CHARS = "\\*?[]{}"


class UsageError(Exception):
    """Bad command-line arguments."""


class EnvError(Exception):
    """The environment cannot run the check (binary missing, too old, ...)."""

    def __init__(self, message: str, binary: dict | None = None) -> None:
        super().__init__(message)
        self.binary = binary


class _ParserExit(Exception):
    """argparse wanted to exit (after --help); main returns this code."""

    def __init__(self, status: int) -> None:
        super().__init__(status)
        self.status = status


class _Parser(argparse.ArgumentParser):
    """stdout carries only JSON: help goes to stderr, and argparse never exits."""

    def error(self, message: str) -> None:
        raise UsageError(f"{message}\n{self.format_usage().strip()}")

    def print_help(self, file=None) -> None:
        super().print_help(sys.stderr if file is None else file)

    def print_usage(self, file=None) -> None:
        super().print_usage(sys.stderr if file is None else file)

    def exit(self, status: int = 0, message: str | None = None) -> None:
        if message:
            sys.stderr.write(message)
        raise _ParserExit(status)


def _error(message: str, file: str | None = None) -> dict:
    return {"file": file, "line": None, "column": None, "message": message}


def _envelope(command: str, ok: bool, binary: dict | None, errors: list, data: dict) -> dict:
    return {
        "schema": SCHEMA_VERSION,
        "ok": ok,
        "command": command,
        "binary": binary,
        "errors": errors,
        "data": data,
    }


def _emit(env: dict, code: int) -> int:
    sys.stdout.write(json.dumps(env, indent=2) + "\n")
    return code


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip() == "1"


def is_headless() -> bool:
    return _truthy("RPCN_HEADLESS") or _truthy("EVAL_RPCN_HEADLESS")


def parse_version(text: str) -> str | None:
    """Return the version from a `Version:` line, without a leading `v`."""
    m = _VERSION_RE.search(text)
    if not m:
        return None
    return f"{m.group(1)}.{m.group(2)}.{m.group(3)}{m.group(4)}"


def _version_key(version: str) -> tuple[int, int, int, int]:
    """Sort key where a pre-release (`4.100.0-rc1`) sorts below its release."""
    major, minor, patch, suffix = re.match(r"(\d+)\.(\d+)\.(\d+)(\S*)", version).groups()
    return int(major), int(minor), int(patch), 0 if suffix.startswith("-") else 1


def _probe(argv: list[str]) -> tuple[str | None, str]:
    """Run `<argv> --version`; return (version or None, a short failure reason)."""
    try:
        proc = subprocess.run(
            [*argv, "--version"],
            capture_output=True,
            text=True,
            timeout=VERSION_TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError:
        return None, "not found"
    except PermissionError:
        return None, "not executable"
    except subprocess.TimeoutExpired:
        return None, f"timed out after {VERSION_TIMEOUT_S}s"
    except OSError as exc:
        return None, str(exc)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        return None, f"exited {proc.returncode}" + (f": {detail[-1]}" if detail else "")
    version = parse_version(proc.stdout) or parse_version(proc.stderr)
    if version is None:
        return None, "printed no `Version:` line"
    return version, ""


def _argv_for(path: str) -> list[str]:
    """`rpk` runs as `rpk connect`; anything else runs directly."""
    if os.path.basename(path) == "rpk":
        return [path, "connect"]
    return [path]


def find_binary() -> dict:
    """Resolve the binary by the AD-4 lookup order.

    Returns {"path", "version", "argv"}; raises EnvError when nothing usable is found.
    """
    for var in ("RPCN_BINARY", "EVAL_RPCN_BINARY"):
        override = os.environ.get(var, "").strip()
        if override:
            path = shutil.which(override) or override
            version, why = _probe(_argv_for(path))
            if version is None:
                raise EnvError(f"{var}={override} is not a usable Redpanda Connect binary ({why}). {INSTALL_HINT}")
            return {"path": path, "version": version, "argv": _argv_for(path)}

    rpk_note = ""
    rpk = shutil.which("rpk")
    if rpk:
        version, why = _probe([rpk, "connect"])
        if version is not None:
            return {"path": rpk, "version": version, "argv": [rpk, "connect"]}
        rpk_note = (
            f"`rpk connect --version` failed ({why}); run `rpk connect install` "
            "to add Redpanda Connect to rpk."
        )

    rpcn = shutil.which("redpanda-connect")
    if rpcn:
        version, why = _probe([rpcn])
        if version is not None:
            return {"path": rpcn, "version": version, "argv": [rpcn]}
        raise EnvError(
            " ".join(filter(None, [rpk_note, f"`{rpcn} --version` failed ({why}).", INSTALL_HINT]))
        )

    if rpk_note:
        raise EnvError(f"{rpk_note} No `redpanda-connect` on PATH either.")
    raise EnvError(f"No Redpanda Connect binary found: neither `rpk` nor `redpanda-connect` is on PATH. {INSTALL_HINT}")


def require_binary() -> dict:
    """find_binary plus the AD-5 version floor."""
    found = find_binary()
    public = {"path": found["path"], "version": found["version"]}
    if _version_key(found["version"]) < _version_key(MIN_VERSION_STR):
        raise EnvError(
            f"Redpanda Connect {found['version']} at {found['path']} is below the supported "
            f"floor {MIN_VERSION_STR}. Upgrade with `rpk connect upgrade` or "
            f"`rpk connect install --connect-version <version>`.",
            binary=public,
        )
    return found


def _newer_than_refs(version: str) -> bool:
    if REFS_VERSION is None:
        return False
    return _version_key(version) > _version_key(REFS_VERSION)


def cmd_binary(_args: argparse.Namespace) -> int:
    data = {
        "plugin_version": PLUGIN_VERSION,
        "refs_version": REFS_VERSION,
        "newer_than_refs": False,
        "headless": is_headless(),
    }
    try:
        found = require_binary()
    except EnvError as exc:
        return _emit(_envelope("binary", False, exc.binary, [_error(str(exc))], data), EXIT_ENV)
    data["newer_than_refs"] = _newer_than_refs(found["version"])
    binary = {"path": found["path"], "version": found["version"]}
    return _emit(_envelope("binary", True, binary, [], data), EXIT_OK)


def escape_glob(path: str) -> str:
    """Escape glob characters so the binary lints exactly this file, not a pattern."""
    return "".join("\\" + ch if ch in _GLOB_CHARS else ch for ch in path)


def parse_lint_output(text: str, matched_only: bool = False) -> list[dict]:
    """Turn `rpk connect lint` text into schema-1 errors, sorted by file, line, column.

    A line `<file>(<line>,<col>) <message>` becomes a file-bound error; any other
    non-empty line becomes an error with file, line and column null, unless
    matched_only is set, when it is dropped (a clean exit 0 can still print an
    `rpk` update notice). Sorting makes the order the same on every RPCN version.
    """
    errors = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m = _LINT_LINE_RE.match(line)
        if m:
            errors.append(
                {
                    "file": m.group("file"),
                    "line": int(m.group("line")),
                    "column": int(m.group("col")),
                    "message": m.group("message"),
                }
            )
        elif not matched_only:
            errors.append(_error(line.strip()))
    errors.sort(
        key=lambda e: (
            e["file"] is None,
            e["file"] or "",
            e["line"] if e["line"] is not None else -1,
            e["column"] if e["column"] is not None else -1,
            e["message"],
        )
    )
    return errors


def _run_bounded(cmd: list[str], timeout: float, env: dict) -> tuple[int, str, str]:
    """Run cmd in its own process group; on timeout kill the whole group.

    Killing only the direct child could leave a grandchild (for example the
    Connect plugin started by `rpk`) holding the output pipes open.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise
    return proc.returncode, stdout, stderr


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def cmd_lint(args: argparse.Namespace) -> int:
    targets: list[str] = args.files
    resources = _unique(args.resources or [])
    env_file: str | None = args.env_file

    def result(ok: bool, binary: dict | None, errors: list, code: int, count: int = 0) -> int:
        return _emit(
            _envelope("lint", ok, binary, errors, {"files": targets, "error_count": count}), code
        )

    # Check files first: the binary reports a missing file as an ordinary lint
    # error (exit 1), which would hide "the check could not run" (exit 2).
    to_check = [("file", t) for t in targets] + [("resources file", r) for r in resources]
    if env_file:
        to_check.append(("env file", env_file))
    missing = [
        _error(f"{kind} not found: {path}", file=path)
        for kind, path in to_check
        if not os.path.exists(path)
    ]
    if missing:
        return result(False, None, missing, EXIT_ENV)

    try:
        found = require_binary()
    except EnvError as exc:
        return result(False, exc.binary, [_error(str(exc))], EXIT_ENV)
    binary = {"path": found["path"], "version": found["version"]}

    cmd = [*found["argv"], *LINT_ARGS]
    for res in resources:
        cmd += ["--resources", escape_glob(res)]
    if env_file:
        cmd += ["--env-file", env_file]
    cmd += [escape_glob(t) for t in _unique(targets)]

    try:
        returncode, stdout, stderr = _run_bounded(cmd, LINT_TIMEOUT_S, {**os.environ, "NO_COLOR": "1"})
    except subprocess.TimeoutExpired:
        return result(False, binary, [_error(f"lint timed out after {LINT_TIMEOUT_S}s")], EXIT_ENV)
    except OSError as exc:
        return result(False, binary, [_error(f"could not run lint: {exc}")], EXIT_ENV)

    # On exit 0 only `file(line,col) msg` lines count: any other line (an `rpk`
    # update notice, say) is noise, not a lint error.
    errors = parse_lint_output(f"{stdout}\n{stderr}", matched_only=returncode == 0)
    if errors:
        return result(False, binary, errors, EXIT_CHECK_FAILED, len(errors))
    if returncode != 0:
        return result(
            False, binary, [_error(f"lint exited {returncode} with no output")], EXIT_ENV
        )
    return result(True, binary, [], EXIT_OK)


# --- hash: file hashes and the hand-off staleness check (AD-6) ----------------

# Hand-off formats this copy can read: artifact -> the majors it knows. Later
# epics add an entry next to their own `tools/shared/formats/<artifact>-format.md`.
# test-report@2 added the Dry run section; @1 stays readable.
KNOWN_FORMATS = {"design": (1,), "test-report": (1, 2)}

HANDOFF_SCALAR_KEYS = (
    "artifact", "format", "pipeline", "status", "produced_by", "rpcn_version", "updated",
)
HANDOFF_STATUSES = ("draft", "ready", "superseded")
PIPELINE_EXTENSIONS = (".yaml", ".yml")  # `<pipeline>.yaml` or `<pipeline>.yml`
_HASH_CHUNK = 1 << 16
_HEADER_KEY_RE = re.compile(r"^(?P<key>[a-z_]+):(?:[ \t]+(?P<value>.*?))?[ \t]*$")
_INPUT_FILE_RE = re.compile(r"^  - file:[ \t]+(?P<value>.*?)[ \t]*$")
_INPUT_SHA_RE = re.compile(r"^    sha256:[ \t]+(?P<value>.*?)[ \t]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_FORMAT_RE = re.compile(r"^(?P<artifact>[a-z][a-z0-9-]*)@(?P<major>\d+)$")
_VERDICT_RE = re.compile(r"^\*\*Verdict:\*\*[ \t]+(?P<verdict>pass|fail)[ \t]*$", re.MULTILINE)


class HeaderError(Exception):
    """A hand-off header that does not follow the strict syntax."""

    def __init__(self, message: str, line: int | None) -> None:
        super().__init__(message)
        self.line = line


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_HASH_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def parse_handoff_header(text: str) -> dict:
    """Parse the strict hand-off frontmatter (see formats/handoff-header.md).

    Returns {"fields": {key: value}, "lines": {key: line}, "inputs": [{"file",
    "sha256", "line"}], "body": text after the closing `---`}. Raises HeaderError with a 1-based line number. This is
    a fixed subset, not YAML: one `key: value` per line, and `inputs:` followed
    by `  - file: <path>` / `    sha256: <64 hex>` pairs (or `inputs: []`).
    """
    lines = text.splitlines()
    if not lines or lines[0].lstrip("\ufeff").rstrip() != "---":
        raise HeaderError("no frontmatter: the first line must be `---`", 1)
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip() == "---"), None)
    if end is None:
        raise HeaderError("frontmatter is not closed: no second `---` line", len(lines))

    fields: dict[str, str] = {}
    key_lines: dict[str, int] = {}
    inputs: list[dict] = []
    in_inputs = False
    pending: dict | None = None  # an input item still waiting for its sha256 line

    for idx in range(1, end):
        n = idx + 1  # 1-based line number in the file
        line = lines[idx]
        if not line.strip():
            continue
        if pending is not None:
            m = _INPUT_SHA_RE.match(line)
            if not m:
                raise HeaderError("an `inputs` item needs `    sha256: <64 hex>` on the next line", n)
            sha = _unquote(m.group("value"))
            if not _SHA256_RE.match(sha):
                raise HeaderError(f"bad sha256 {sha!r}: expected 64 lowercase hex characters", n)
            pending["sha256"] = sha
            inputs.append(pending)
            pending = None
            continue
        if line.startswith(" "):
            if not in_inputs:
                raise HeaderError(f"unexpected indented line: {line.strip()!r}", n)
            m = _INPUT_FILE_RE.match(line)
            if not m:
                raise HeaderError(
                    "an `inputs` item must be exactly `  - file: <path>` then `    sha256: <64 hex>`", n
                )
            path = _unquote(m.group("value"))
            if not path:
                raise HeaderError("an `inputs` item has an empty `file`", n)
            if os.path.isabs(path):
                raise HeaderError(
                    f"input file {path!r} must be relative to the hand-off file's folder", n
                )
            pending = {"file": path, "sha256": "", "line": n}
            continue

        in_inputs = False
        m = _HEADER_KEY_RE.match(line)
        if not m:
            raise HeaderError(f"expected `key: value`, got {line.strip()!r}", n)
        key, value = m.group("key"), m.group("value") or ""
        if key in fields or (key == "inputs" and "inputs" in key_lines):
            raise HeaderError(f"duplicate key `{key}` (first on line {key_lines[key]})", n)
        if key == "inputs":
            key_lines["inputs"] = n
            if value == "[]":
                continue
            if value:
                raise HeaderError("`inputs:` takes block items on the next lines, or `[]`", n)
            in_inputs = True
            continue
        if key not in HANDOFF_SCALAR_KEYS:
            raise HeaderError(f"unknown key `{key}`", n)
        value = _unquote(value)
        if not value:
            raise HeaderError(f"`{key}` has no value", n)
        if key == "status" and value not in HANDOFF_STATUSES:
            raise HeaderError(f"bad status {value!r}: expected one of {', '.join(HANDOFF_STATUSES)}", n)
        fields[key] = value
        key_lines[key] = n

    if pending is not None:
        raise HeaderError("an `inputs` item needs `    sha256: <64 hex>` on the next line", end + 1)
    missing = [k for k in (*HANDOFF_SCALAR_KEYS, "inputs") if k not in key_lines]
    if missing:
        raise HeaderError(f"missing key(s): {', '.join(missing)}", end + 1)
    body = "\n".join(lines[end + 1:])
    return {"fields": fields, "lines": key_lines, "inputs": inputs, "body": body}


def report_verdict(artifact: str, body: str) -> str | None:
    """The first `**Verdict:** pass|fail` line of a test report body; None otherwise."""
    if artifact != "test-report":
        return None
    m = _VERDICT_RE.search(body)
    return m.group("verdict") if m else None


def format_known(artifact: str, fmt: str) -> bool:
    """`fmt` is `<artifact>@<major>`, names this artifact, and its major is a known one."""
    m = _FORMAT_RE.match(fmt)
    if not m or m.group("artifact") != artifact:
        return False
    return int(m.group("major")) in KNOWN_FORMATS.get(artifact, ())


def _hash_files(files: list[str]) -> int:
    missing = [
        _error(f"not a file: {f}" if os.path.exists(f) else f"file not found: {f}", file=f)
        for f in files
        if not os.path.isfile(f)
    ]
    if missing:
        return _emit(_envelope("hash", False, None, missing, {"hashes": []}), EXIT_ENV)
    hashes, errors = [], []
    for f in files:
        try:
            hashes.append({"file": f, "sha256": sha256_file(f)})
        except OSError as exc:
            errors.append(_error(f"cannot read {f}: {exc.strerror or exc}", file=f))
    if errors:
        return _emit(_envelope("hash", False, None, errors, {"hashes": []}), EXIT_ENV)
    return _emit(_envelope("hash", True, None, [], {"hashes": hashes}), EXIT_OK)


def _check_handoff(handoff: str) -> int:
    def fail(message: str, line: int | None = None) -> int:
        err = {"file": handoff, "line": line, "column": None, "message": message}
        return _emit(_envelope("hash", False, None, [err], {}), EXIT_ENV)

    if not os.path.isfile(handoff):
        what = "is not a file" if os.path.exists(handoff) else "not found"
        return fail(f"hand-off file {what}: {handoff}")
    try:
        with open(handoff, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        return fail(f"cannot read hand-off file: {exc}")
    try:
        header = parse_handoff_header(text)
    except HeaderError as exc:
        return fail(f"bad hand-off header: {exc}", exc.line)

    fields, key_lines = header["fields"], header["lines"]
    folder = os.path.dirname(handoff)
    known = format_known(fields["artifact"], fields["format"])
    errors: list[dict] = []
    inputs = []
    for item in header["inputs"]:
        path = os.path.join(folder, item["file"])
        try:
            current = sha256_file(path) if os.path.isfile(path) else None
        except OSError as exc:
            err = _error(f"cannot read input {item['file']}: {exc.strerror or exc}", file=path)
            return _emit(_envelope("hash", False, None, [err], {}), EXIT_ENV)
        if current is None:
            state = "missing"
            errors.append(_error(f"input missing: {item['file']}", file=path))
        elif current != item["sha256"]:
            state = "changed"
            errors.append(_error(f"input changed since the hand-off was written: {item['file']}", file=path))
        else:
            state = "match"
        inputs.append({"file": item["file"], "recorded": item["sha256"], "current": current, "state": state})

    pipeline_files = tuple(
        os.path.normpath(f"{fields['pipeline']}{ext}") for ext in PIPELINE_EXTENSIONS
    )
    if fields["artifact"] == "test-report":
        first = os.path.normpath(header["inputs"][0]["file"]) if header["inputs"] else None
        if first not in pipeline_files:
            got = f"the first input is {header['inputs'][0]['file']!r}" if first else "inputs is empty"
            errors.append(
                {"file": handoff, "line": key_lines["inputs"], "column": None,
                 "message": f"a test report's first input must be the pipeline file "
                            f"{' or '.join(pipeline_files)}; {got}"}
            )
    if fields["status"] != "ready":
        errors.append(
            {"file": handoff, "line": key_lines["status"], "column": None,
             "message": f"status is {fields['status']!r}, not 'ready'"}
        )
    if not known:
        errors.append(
            {"file": handoff, "line": key_lines["format"], "column": None,
             "message": f"unknown format {fields['format']!r} for artifact {fields['artifact']!r}"}
        )
    ready = not errors
    verdict = report_verdict(fields["artifact"], header["body"])
    pipeline_matches = bool(inputs) and (
        os.path.normpath(inputs[0]["file"]) in pipeline_files and inputs[0]["state"] == "match"
    )
    data = {
        "artifact": fields["artifact"],
        "status": fields["status"],
        "format": fields["format"],
        "format_known": known,
        "inputs": inputs,
        "ready": ready,
        "verdict": verdict,
        "pipeline_ready": ready and pipeline_matches and verdict == "pass",
    }
    return _emit(_envelope("hash", ready, None, errors, data), EXIT_OK if ready else EXIT_CHECK_FAILED)


def cmd_hash(args: argparse.Namespace) -> int:
    files: list[str] = args.files or []

    def usage(message: str) -> int:
        return _emit(_envelope("hash", False, None, [_error(message)], {}), EXIT_ENV)

    if args.check is not None:
        if files:
            return usage("give either files to hash or --check <handoff.md>, not both")
        return _check_handoff(args.check)
    if not files:
        return usage("give at least one file to hash, or --check <handoff.md>")
    return _hash_files(files)


# --- blobl, list, fields, run, test: the rest of the AD-4 adapter -------------

CHECK_TIMEOUT_S = 60  # every binary call except `run`
RUN_TIMEOUT_S = 10.0  # `run` default (AD-4)
RUN_ARGS = ("run", "--set", "http.enabled=false")  # fixed by AD-4
# `run --bounded`: the config's input and output are replaced by stdin and stdout
# (each `--set` with an object replaces the whole value; SOURCES.md), the logger
# is pinned so errors are logged as logfmt, and an output processor turns each
# message that reaches the output still errored into a marker line. The binary
# splits a `--set` value on commas, so each value, the mapping included, has none.
RUN_MARKER_KEY = "__rpcn_check_unhandled_error__"
RUN_MARKER_MAPPING = (
    "if errored() {\\n  root = {}\\n"
    f"  root.{RUN_MARKER_KEY}.error = error()\\n"
    f"  root.{RUN_MARKER_KEY}.input = content().string()\\n}}"
)
RUN_BOUNDED_ARGS = (
    "--set", 'input={"stdin":{}}',
    "--set", 'output={"stdout":{}}',
    "--set", "logger.format=logfmt",
    "--set", "logger.level=info",
    "--set", f'output.processors=[{{"mapping":"{RUN_MARKER_MAPPING}"}}]',
)
LIST_STATUSES = ("stable", "beta", "experimental")
STDERR_TAIL_LINES = 10

_BLOBL_EXEC_PREFIX = "failed to execute map: "
_BLOBL_PARSE_RE = re.compile(
    r"^failed to parse mapping: line (?P<line>\d+) char (?P<col>\d+): (?P<message>.*)$"
)
_RUN_LINT_RE = re.compile(r'msg="Config lint error".*?\blint="(?P<lint>(?:[^"\\]|\\.)*)"')
_LOGFMT_PAIR_RE = re.compile(r'(?:^|\s)(?P<key>[A-Za-z_@][\w.@-]*)=(?P<value>"(?:[^"\\]|\\.)*"|\S*)')
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_TEST_RESULT_RE = re.compile(r"^Test '(?P<file>.+)' (?P<result>failed|succeeded)$")
_TEST_INIT_RE = re.compile(r"^Failed to execute test target '(?P<file>.+?)': (?P<message>.*)$")
_TEST_SECTION_RE = re.compile(r"^--- (?P<file>.+) ---$")
_TEST_CASE_RE = re.compile(r"^(?P<case>\S.*?)(?: \[line (?P<line>\d+)\])?:$")
_NO_TESTS = "No tests were found"


def _missing_files(pairs: list[tuple[str, str | None]]) -> list[dict]:
    """One error per (kind, path) whose path does not exist; None paths are skipped."""
    return [
        _error(f"{kind} not found: {path}", file=path)
        for kind, path in pairs
        if path is not None and not os.path.exists(path)
    ]


def _run_io(
    cmd: list[str],
    timeout: float,
    stdin_path: str | None = None,
    stdin_text: str | None = None,
    merge_stderr: bool = False,
) -> tuple[int | None, str, str]:
    """Run cmd in its own process group with NO_COLOR=1; stdin from a file, a string or empty.

    Returns (returncode, stdout, stderr). On timeout the whole group is killed
    and returncode is None; the output read until then is kept. With
    merge_stderr, stderr goes into the stdout pipe so the order is kept.
    """
    env = {**os.environ, "NO_COLOR": "1"}
    stdin_file = open(stdin_path, "rb") if stdin_path is not None else None
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=stdin_file if stdin_file else (subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            start_new_session=True,
        )
    finally:
        if stdin_file:
            stdin_file.close()
    try:
        stdout, stderr = proc.communicate(input=stdin_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = proc.communicate()
        return None, stdout or "", stderr or ""
    return proc.returncode, stdout or "", stderr or ""


def _tail(text: str, n: int = STDERR_TAIL_LINES) -> str:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    return "\n".join(lines[-n:])


def _binary_or_error(command: str, data: dict) -> tuple[dict | None, int | None]:
    """(found, None), or (None, exit code) after emitting the environment error."""
    try:
        return require_binary(), None
    except EnvError as exc:
        return None, _emit(_envelope(command, False, exc.binary, [_error(str(exc))], data), EXIT_ENV)


def _public(found: dict) -> dict:
    return {"path": found["path"], "version": found["version"]}


def _go_lines(text: str) -> list[str]:
    """Split like Go's bufio.ScanLines: on \\n, dropping one trailing \\r and a final empty line."""
    parts = text.split("\n")
    if parts and parts[-1] == "":
        parts.pop()
    return [p[:-1] if p.endswith("\r") else p for p in parts]


# --- blobl ---------------------------------------------------------------------


def _blobl_parse_error(text: str, mapping: str) -> dict | None:
    for raw in text.splitlines():
        m = _BLOBL_PARSE_RE.match(raw.strip())
        if m:
            return {
                "file": mapping,
                "line": int(m.group("line")),
                "column": int(m.group("col")),
                "message": m.group("message"),
            }
    return None


def _blobl_result(n: int, text: str) -> dict:
    if text.startswith(_BLOBL_EXEC_PREFIX):
        return {"line": n, "output": None, "error": text[len(_BLOBL_EXEC_PREFIX):]}
    return {"line": n, "output": text, "error": None}


SAMPLES_FORMAT = "samples@1"
_SAMPLES_TOP_KEYS = ("format", "pipeline", "mappings")
_SAMPLE_KEYS = ("name", "input", "output", "deleted")


class SamplesError(Exception):
    """A samples file that does not follow samples-format.md."""

    def __init__(self, message: str, line: int | None = None, column: int | None = None) -> None:
        super().__init__(message)
        self.line = line
        self.column = column


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise SamplesError(f"duplicate key {key!r}")
        out[key] = value
    return out


def _reject_constant(name: str) -> object:
    raise SamplesError(f"{name} is not a JSON value")


class _Constant:
    """What parse_constant returns for NaN, Infinity or -Infinity, so the key can be named."""

    def __init__(self, name: str) -> None:
        self.name = name


def _find_constant(value: object, path: str) -> str | None:
    """`<key path>: <constant>` for the first NaN or Infinity in value, or None."""
    if isinstance(value, _Constant):
        return f"{path or '<top>'}: {value.name}"
    if isinstance(value, dict):
        for k, v in value.items():
            step = (f".{k}" if path else k) if k.isidentifier() else f"[{json.dumps(k)}]"
            found = _find_constant(v, path + step)
            if found:
                return found
    if isinstance(value, list):
        for i, v in enumerate(value):
            found = _find_constant(v, f"{path}[{i}]")
            if found:
                return found
    return None


def parse_samples(text: str) -> dict:
    """Parse and validate a `<name>.samples.json` (samples@1); raise SamplesError naming the line or key."""
    try:
        # NaN and Infinity are parsed here and rejected below, naming their key.
        doc = json.loads(text, object_pairs_hook=_no_duplicate_keys, parse_constant=_Constant)
    except json.JSONDecodeError as exc:
        raise SamplesError(f"not valid JSON: {exc.msg}", exc.lineno, exc.colno) from None
    bad = _find_constant(doc, "")
    if bad:
        raise SamplesError(f"{bad} is not a JSON value")
    if not isinstance(doc, dict):
        raise SamplesError("the file must hold one JSON object")
    for key in doc:
        if key not in _SAMPLES_TOP_KEYS:
            raise SamplesError(f"{key}: unknown key")
    for key in _SAMPLES_TOP_KEYS:
        if key not in doc:
            raise SamplesError(f"{key}: required key is missing")
    if doc["format"] != SAMPLES_FORMAT:
        raise SamplesError(f"format: must be {SAMPLES_FORMAT!r}, got {doc['format']!r}")
    if not isinstance(doc["pipeline"], str) or not doc["pipeline"].strip():
        raise SamplesError("pipeline: must be a non-empty string")
    mappings = doc["mappings"]
    if not isinstance(mappings, dict) or not mappings:
        raise SamplesError("mappings: must be a non-empty object")
    for key, samples in mappings.items():
        where = f"mappings[{json.dumps(key)}]"
        if not key.endswith(".blobl") or "/" in key or "\\" in key or key == ".blobl":
            raise SamplesError(f"{where}: the key must be a bare .blobl file name")
        if not isinstance(samples, list) or not samples:
            raise SamplesError(f"{where}: must be a non-empty array of samples")
        names: set[str] = set()
        for i, sample in enumerate(samples):
            at = f"{where}[{i}]"
            if not isinstance(sample, dict):
                raise SamplesError(f"{at}: must be an object")
            for k in sample:
                if k not in _SAMPLE_KEYS:
                    raise SamplesError(f"{at}.{k}: unknown key")
            name = sample.get("name")
            if not isinstance(name, str) or not name.strip():
                raise SamplesError(f"{at}.name: must be a non-empty string")
            if name in names:
                raise SamplesError(f"{at}.name: {name!r} is used twice in this mapping")
            names.add(name)
            if "input" not in sample:
                raise SamplesError(f"{at}.input: required key is missing")
            if ("output" in sample) == ("deleted" in sample):
                raise SamplesError(f"{at}: needs exactly one of output and deleted")
            if "deleted" in sample and sample["deleted"] is not True:
                raise SamplesError(f"{at}.deleted: must be true")
    return doc


def _compact(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def json_equal(a: object, b: object) -> bool:
    """JSON value equality: 1 equals 1.0, but true never equals 1."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def compare_sample(sample: dict, result: dict) -> dict:
    """One `data.samples[]` entry: the sample, what it expected and what the mapping printed."""
    deleted = sample.get("deleted") is True
    entry = {
        "name": sample["name"],
        "input": _compact(sample["input"]),
        "expected": None if deleted else _compact(sample["output"]),
        "deleted": deleted,
        "actual": result["output"],
        "error": result["error"],
        "result": "fail",
    }
    actual = result["output"]
    if actual is None:
        return entry
    if actual == "":  # a deleted message (an empty string prints the same)
        entry["result"] = "pass" if deleted else "fail"
        return entry
    if deleted:
        return entry
    expected = sample["output"]
    if isinstance(expected, str):
        # A string root prints raw, without quotes: compare the text as printed.
        entry["result"] = "pass" if actual == expected else "fail"
        return entry
    try:
        value = json.loads(actual, parse_constant=_reject_constant)
    except (ValueError, SamplesError):
        entry["result"] = "fail"  # not JSON, so it can't equal a non-string value
        return entry
    entry["result"] = "pass" if json_equal(expected, value) else "fail"
    return entry


def _sample_error(entry: dict, samples_file: str) -> dict:
    name = entry["name"]
    if entry["error"] is not None:
        message = f"sample {name!r}: {entry['error']}"
    elif entry["deleted"]:
        message = f"sample {name!r}: expected the message deleted, got {entry['actual']}"
    elif entry["actual"] == "":
        message = f"sample {name!r}: expected {entry['expected']}, got a deleted message"
    else:
        message = f"sample {name!r}: expected {entry['expected']}, got {entry['actual']}"
    return _error(message, file=samples_file)


def _blobl_exec(
    found: dict, mapping: str, env_file: str | None, input_file: str | None
) -> tuple[list[dict] | None, list[dict], int]:
    """Run the mapping over input_file's lines: (results, [], 0), or (None, errors, exit code)."""
    base = [*found["argv"], "blobl"]
    if env_file:
        base += ["--env-file", env_file]
    base += ["--file", mapping]
    cmd = base + (["--input", input_file] if input_file else [])

    lines: list[str] = []
    if input_file:
        try:
            with open(input_file, encoding="utf-8", errors="replace") as fh:
                lines = _go_lines(fh.read())
        except OSError as exc:
            return None, [_error(f"cannot read input file: {exc}", file=input_file)], EXIT_ENV

    deadline_err = [_error(f"blobl timed out after {CHECK_TIMEOUT_S}s")]
    start = time.monotonic()  # one 60 s budget for the whole call, fallback included
    try:
        # stderr merged into stdout keeps each line's output or error in input order.
        returncode, out, _ = _run_io(cmd, CHECK_TIMEOUT_S, merge_stderr=True)
    except OSError as exc:
        return None, [_error(f"could not run blobl: {exc}")], EXIT_ENV
    if returncode is None:
        return None, deadline_err, EXIT_ENV
    if returncode != 0:
        err = _blobl_parse_error(out, mapping)
        if err is None:
            if not out.strip():
                return None, [_error(f"blobl exited {returncode} with no output", file=mapping)], EXIT_ENV
            err = _error(f"blobl exited {returncode}: {_tail(out)}", file=mapping)
        return None, [err], EXIT_CHECK_FAILED

    printed = _go_lines(out)
    if len(printed) == len(lines):
        return [_blobl_result(i + 1, text) for i, text in enumerate(printed)], [], EXIT_OK
    # Some output spans several lines (a string with newlines), so lines
    # cannot be matched by position: run each input line on its own.
    results = []
    for i, line in enumerate(lines):
        remaining = CHECK_TIMEOUT_S - (time.monotonic() - start)
        if remaining <= 0:
            return None, deadline_err, EXIT_ENV
        try:
            rc, one_out, one_err = _run_io(base, remaining, stdin_text=line + "\n")
        except OSError as exc:
            return None, [_error(f"could not run blobl: {exc}")], EXIT_ENV
        if rc is None:
            return None, deadline_err, EXIT_ENV
        failed = [ln for ln in one_err.splitlines() if ln.startswith(_BLOBL_EXEC_PREFIX)]
        if failed:
            results.append(_blobl_result(i + 1, failed[0]))
        elif rc != 0:
            tail = _tail(f"{one_out}\n{one_err}")
            message = f"blobl exited {rc}" + (f": {tail}" if tail else " with no output")
            results.append({"line": i + 1, "output": None, "error": message})
        else:
            results.append({"line": i + 1, "output": one_out[:-1] if one_out.endswith("\n") else one_out, "error": None})
    return results, [], EXIT_OK


def cmd_blobl(args: argparse.Namespace) -> int:
    mapping: str = args.mapping
    input_file: str | None = args.input
    samples_file: str | None = args.samples
    env_file: str | None = args.env_file
    data: dict = {"mapping": mapping, "results": []}
    if samples_file is not None:
        data.update({"samples_file": samples_file, "samples": [], "passed": 0, "failed": 0})

    def result(ok: bool, binary: dict | None, errors: list, code: int) -> int:
        return _emit(_envelope("blobl", ok, binary, errors, data), code)

    missing = _missing_files(
        [("mapping file", mapping), ("input file", input_file), ("samples file", samples_file),
         ("env file", env_file)]
    )
    if missing:
        return result(False, None, missing, EXIT_ENV)

    samples: list[dict] = []
    if samples_file is not None:
        # The samples file is checked before the binary is looked up or run.
        try:
            with open(samples_file, encoding="utf-8") as fh:
                doc = parse_samples(fh.read())
        except (OSError, UnicodeDecodeError) as exc:
            return result(False, None, [_error(f"cannot read samples file: {exc}", file=samples_file)], EXIT_ENV)
        except SamplesError as exc:
            err = {"file": samples_file, "line": exc.line, "column": exc.column, "message": str(exc)}
            return result(False, None, [err], EXIT_ENV)
        key = os.path.basename(mapping)
        if key not in doc["mappings"]:
            return result(
                False, None,
                [_error(f"no samples for {key!r} in mappings (keys: {', '.join(doc['mappings'])})",
                        file=samples_file)],
                EXIT_ENV,
            )
        samples = doc["mappings"][key]

    found, code = _binary_or_error("blobl", data)
    if found is None:
        return code
    binary = _public(found)

    if samples_file is None:
        results, errors, code = _blobl_exec(found, mapping, env_file, input_file)
        if results is None:
            return result(False, binary, errors, code)
        data["results"] = results
        errors = [
            {"file": input_file, "line": r["line"], "column": None, "message": r["error"]}
            for r in results
            if r["error"] is not None
        ]
        if errors:
            return result(False, binary, errors, EXIT_CHECK_FAILED)
        return result(True, binary, [], EXIT_OK)

    # Samples: one compact JSON input per line, in the file's order.
    with tempfile.TemporaryDirectory(prefix="rpcn-samples-") as tmp:
        lines_file = os.path.join(tmp, "inputs.jsonl")
        with open(lines_file, "w", encoding="utf-8") as fh:
            fh.write("".join(_compact(s["input"]) + "\n" for s in samples))
        results, errors, code = _blobl_exec(found, mapping, env_file, lines_file)
    if results is None:
        return result(False, binary, errors, code)
    if len(results) != len(samples):
        return result(
            False, binary,
            [_error(f"blobl gave {len(results)} results for {len(samples)} samples", file=mapping)],
            EXIT_ENV,
        )
    data["results"] = results
    entries = [compare_sample(s, r) for s, r in zip(samples, results)]
    data["samples"] = entries
    data["passed"] = sum(e["result"] == "pass" for e in entries)
    data["failed"] = len(entries) - data["passed"]
    errors = [_sample_error(e, samples_file) for e in entries if e["result"] == "fail"]
    if errors:
        return result(False, binary, errors, EXIT_CHECK_FAILED)
    return result(True, binary, [], EXIT_OK)


# --- list and fields -----------------------------------------------------------


def _list_json(found: dict, extra: list[str]) -> tuple[dict | None, str | None]:
    """Run `list --format <...>` and parse its JSON object; (None, reason) on failure."""
    cmd = [*found["argv"], "list", *extra]
    try:
        returncode, out, err = _run_io(cmd, CHECK_TIMEOUT_S)
    except OSError as exc:
        return None, f"could not run list: {exc}"
    if returncode is None:
        return None, f"list timed out after {CHECK_TIMEOUT_S}s"
    if returncode != 0:
        return None, f"list exited {returncode}" + (f": {_tail(err or out)}" if (err or out).strip() else "")
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError as exc:
        return None, f"list printed invalid JSON: {exc}"
    if not isinstance(parsed, dict):
        return None, "list printed JSON that is not an object"
    return parsed, None


def _categories(found: dict) -> tuple[list[str] | None, str | None]:
    parsed, why = _list_json(found, ["--format", "json"])
    if parsed is None:
        return None, why
    return sorted(parsed), None


def _check_category(found: dict, category: str) -> str | None:
    """None when `category` is a key of the unfiltered `list --format json`; else the error."""
    cats, why = _categories(found)
    if cats is None:
        return why
    if category not in cats:
        return f"unknown category {category!r}. Known categories: {', '.join(cats)}."
    return None


def cmd_list(args: argparse.Namespace) -> int:
    category: str = args.category
    data: dict = {"category": category, "components": []}

    def result(ok: bool, binary: dict | None, errors: list, code: int) -> int:
        return _emit(_envelope("list", ok, binary, errors, data), code)

    found, code = _binary_or_error("list", data)
    if found is None:
        return code
    binary = _public(found)
    bad = _check_category(found, category)
    if bad:
        return result(False, binary, [_error(bad)], EXIT_ENV)
    extra = ["--format", "json"]
    if args.status:
        extra += ["--status", args.status]
    parsed, why = _list_json(found, [*extra, category])
    if parsed is None:
        return result(False, binary, [_error(why)], EXIT_ENV)
    names = parsed.get(category)  # a valid category the filter emptied may be absent
    if not isinstance(names, list):
        names = []
    data["components"] = [n for n in names if isinstance(n, str)]
    return result(True, binary, [], EXIT_OK)


def _first_line(text: object) -> str:
    if not isinstance(text, str):
        return ""
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def _child_prefix(path: str, kind: str) -> str:
    """Where a field's children sit: `a.b` for objects, `a[].b` for arrays, `a.*.b` for maps."""
    if kind == "array":
        return f"{path}[]."
    if kind == "2darray":
        return f"{path}[][]."
    if kind == "map":
        return f"{path}.*."
    return f"{path}."


def flatten_fields(children: list, prefix: str = "") -> list[dict]:
    """Flatten a json-full `config.children` tree into dotted field entries."""
    fields: list[dict] = []
    for child in children or []:
        if not isinstance(child, dict):
            continue
        path = f"{prefix}{child.get('name', '')}"
        entry = {
            "path": path,
            "type": child.get("type", ""),
            "kind": child.get("kind", ""),
            "required": "default" not in child and child.get("is_optional") is not True,
        }
        if "default" in child:
            entry["default"] = child["default"]
        entry.update(
            {
                "advanced": child.get("is_advanced") is True,
                "deprecated": child.get("is_deprecated") is True,
                "secret": child.get("is_secret") is True,
                "description": _first_line(child.get("description")),
            }
        )
        fields.append(entry)
        fields.extend(flatten_fields(child.get("children") or [], _child_prefix(path, entry["kind"])))
    return fields


def _close_matches(name: str, names: list[str]) -> list[str]:
    """Names sharing a prefix with `name`: longest shared prefix first, at least 3 characters."""

    def shared(other: str) -> int:
        return len(os.path.commonprefix([name, other]))

    need = min(3, len(name))
    scored = [(shared(n), n) for n in names if need and shared(n) >= need]
    return [n for _, n in sorted(scored, key=lambda s: (-s[0], s[1]))]


def cmd_fields(args: argparse.Namespace) -> int:
    category: str = args.category
    component: str = args.component
    data: dict = {"category": category, "component": component, "status": None, "fields": []}

    def result(ok: bool, binary: dict | None, errors: list, code: int) -> int:
        return _emit(_envelope("fields", ok, binary, errors, data), code)

    found, code = _binary_or_error("fields", data)
    if found is None:
        return code
    binary = _public(found)
    bad = _check_category(found, category)
    if bad:
        return result(False, binary, [_error(bad)], EXIT_ENV)
    parsed, why = _list_json(found, ["--format", "json-full", category])
    if parsed is None:
        return result(False, binary, [_error(why)], EXIT_ENV)
    components = parsed.get(category)
    if not isinstance(components, list):
        components = []
    by_name = {c.get("name"): c for c in components if isinstance(c, dict)}
    comp = by_name.get(component)
    if comp is None:
        data["components"] = _close_matches(component, [n for n in by_name if isinstance(n, str)])
        return result(
            False, binary, [_error(f"component {component!r} not found in {category}")], EXIT_CHECK_FAILED
        )
    config = comp.get("config") if isinstance(comp.get("config"), dict) else {}
    root_prefix = "[]." if config.get("kind") == "array" else ""
    data["status"] = comp.get("status", "")
    data["fields"] = flatten_fields(config.get("children") or [], root_prefix)
    return result(True, binary, [], EXIT_OK)


# --- run -----------------------------------------------------------------------


def _unescape_logfmt(value: str) -> str:
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), value)


def parse_run_lint_errors(text: str) -> list[dict]:
    """File errors from `Config lint error` log lines (`lint="<file>(<l>,<c>) <msg>"`)."""
    errors = []
    for raw in text.splitlines():
        m = _RUN_LINT_RE.search(raw)
        if not m:
            continue
        lint = _unescape_logfmt(m.group("lint"))
        lm = _LINT_LINE_RE.match(lint)
        if lm:
            errors.append(
                {
                    "file": lm.group("file"),
                    "line": int(lm.group("line")),
                    "column": int(lm.group("col")),
                    "message": lm.group("message"),
                }
            )
        else:
            errors.append(_error(lint))
    return errors


def parse_logfmt(line: str) -> dict[str, str]:
    """The key=value pairs of one logfmt line, quoted values unescaped; the first of a repeated key wins."""
    pairs: dict[str, str] = {}
    for m in _LOGFMT_PAIR_RE.finditer(line):
        value = m.group("value")
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = _unescape_logfmt(value[1:-1])
        pairs.setdefault(m.group("key"), value)
    return pairs


def parse_runtime_errors(text: str) -> list[dict]:
    """`{path, message, input}` for each stderr log line with `level=error` and a `path=`.

    A processor that fails on a message logs this and the binary still exits 0
    (SOURCES.md). Without `--bounded` these lines are the only sign of a runtime
    error; `input` is then always null. A caught error logs the same line.
    """
    found = []
    for raw in text.splitlines():
        fields = parse_logfmt(raw)
        if fields.get("level") != "error" or not fields.get("path"):
            continue
        found.append({"path": fields["path"], "message": fields.get("msg", raw.strip()), "input": None})
    return found


def _marker(line: str) -> dict | None:
    """The `{error, input}` of a `--bounded` marker line, or None for any other line."""
    try:
        value = json.loads(line)
    except ValueError:
        return None
    if not isinstance(value, dict) or list(value) != [RUN_MARKER_KEY]:
        return None
    inner = value[RUN_MARKER_KEY]
    if not isinstance(inner, dict) or not isinstance(inner.get("error"), str):
        return None
    return {"error": inner["error"], "input": inner.get("input") if isinstance(inner.get("input"), str) else None}


def split_unhandled_errors(outputs: list[str], logged: list[dict]) -> tuple[list[str], list[dict]]:
    """Move `--bounded` marker lines out of outputs, as `{path, message, input}`.

    `path` is taken from the first logged error with the same message not yet
    matched (log lines only give the processor path), else null.
    """
    kept, unhandled = [], []
    unused = list(logged)
    for line in outputs:
        marker = _marker(line)
        if marker is None:
            kept.append(line)
            continue
        path = None
        for i, entry in enumerate(unused):
            if entry["message"] == marker["error"]:
                path = entry["path"]
                del unused[i]
                break
        unhandled.append({"path": path, "message": marker["error"], "input": marker["input"]})
    return kept, unhandled


def _positive_float(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    if not value > 0 or value != value or value == float("inf"):
        raise argparse.ArgumentTypeError(f"must be a positive number of seconds: {text!r}")
    return value


def _fmt_seconds(value: float) -> str:
    return f"{value:g}"


def cmd_run(args: argparse.Namespace) -> int:
    config: str = args.config
    input_file: str | None = args.input
    resources = _unique(args.resources or [])
    env_file: str | None = args.env_file
    timeout: float = args.timeout
    bounded: bool = args.bounded
    data: dict = {"config": config, "outputs": [], "exit": None, "runtime_errors": []}

    def result(ok: bool, binary: dict | None, errors: list, code: int) -> int:
        return _emit(_envelope("run", ok, binary, errors, data), code)

    if bounded and input_file is None:
        return _emit(_envelope("run", False, None, [_error("--bounded needs --input")], {}), EXIT_ENV)
    missing = _missing_files(
        [("config file", config), ("input file", input_file)]
        + [("resources file", r) for r in resources]
        + [("env file", env_file)]
    )
    if missing:
        return result(False, None, missing, EXIT_ENV)
    found, code = _binary_or_error("run", data)
    if found is None:
        return code
    binary = _public(found)

    cmd = [*found["argv"], *RUN_ARGS]
    if bounded:
        cmd += RUN_BOUNDED_ARGS
    for res in resources:
        cmd += ["--resources", escape_glob(res)]
    if env_file:
        cmd += ["--env-file", env_file]
    cmd.append(config)  # `run` reads this path as given; it is not a glob
    try:
        returncode, out, err = _run_io(cmd, timeout, stdin_path=input_file)
    except OSError as exc:
        return result(False, binary, [_error(f"could not run the pipeline: {exc}")], EXIT_ENV)
    data["outputs"] = _go_lines(out)
    logged = parse_runtime_errors(err)
    if bounded:
        # Only a message still errored at the output fails (SOURCES.md): a caught
        # error logs the same line, so logged errors alone are not failures.
        data["outputs"], data["runtime_errors"] = split_unhandled_errors(data["outputs"], logged)
    else:
        data["runtime_errors"] = logged
    runtime = [
        _error(f"{e['path']}: {e['message']}" if e["path"] else e["message"], file=config)
        for e in data["runtime_errors"]
    ]
    if returncode is None:
        return result(
            False, binary, [_error(f"run timed out after {_fmt_seconds(timeout)}s"), *runtime], EXIT_ENV
        )
    data["exit"] = returncode
    if returncode == 0:
        if runtime:
            return result(False, binary, runtime, EXIT_CHECK_FAILED)
        return result(True, binary, [], EXIT_OK)
    errors = parse_run_lint_errors(err)
    if not errors and not runtime:
        tail = _tail(err)
        errors = [_error(f"run exited {returncode}" + (f": {tail}" if tail else " with no output"))]
    return result(False, binary, [*errors, *runtime], EXIT_CHECK_FAILED)


# --- test ----------------------------------------------------------------------


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def parse_test_output(text: str) -> dict:
    """Parse one stream of `rpk connect test` text (ANSI already stripped).

    Recognises `Test '<f>' failed|succeeded`, `Failed to execute test target
    '<f>': <msg>`, `No tests were found`, and the `Failures:` block: a
    `--- <f> ---` line per target, then `<case> [line N]:` after a blank line,
    followed by that case's detail lines.
    """
    targets: dict[str, bool] = {}
    failures: list[dict] = []
    init_errors: list[dict] = []
    no_tests = False
    section: str | None = None
    current: dict | None = None
    detail: list[str] = []
    prev_blank = True

    def close_case() -> None:
        nonlocal current, detail
        if current is not None:
            while detail and not detail[-1].strip():
                detail.pop()
            current["message"] = "\n".join(detail)
            failures.append(current)
        current, detail = None, []

    for raw in text.splitlines():
        line = raw.rstrip()
        blank = not line.strip()
        m_res = _TEST_RESULT_RE.match(line)
        m_init = _TEST_INIT_RE.match(line)
        m_sec = _TEST_SECTION_RE.match(line)
        m_case = _TEST_CASE_RE.match(line) if section is not None and prev_blank else None
        if m_res and section is None:
            targets[m_res.group("file")] = m_res.group("result") == "succeeded"
        elif m_init and current is None:
            targets[m_init.group("file")] = False
            init_errors.append(
                _error(f"failed to execute test target: {m_init.group('message')}", file=m_init.group("file"))
            )
        elif line.strip() == _NO_TESTS and current is None:
            no_tests = True
        elif m_sec and prev_blank:
            close_case()
            section = m_sec.group("file")
            targets.setdefault(section, False)
        elif m_case:
            close_case()
            current = {
                "target": section,
                "case": m_case.group("case"),
                "line": int(m_case.group("line")) if m_case.group("line") else None,
                "message": "",
            }
        elif current is not None and (detail or not blank):
            detail.append(line)
        prev_blank = blank
    close_case()
    return {"targets": targets, "failures": failures, "init_errors": init_errors, "no_tests": no_tests}


def cmd_test(args: argparse.Namespace) -> int:
    target: str = args.target
    resources = _unique(args.resources or [])
    env_file: str | None = args.env_file
    data: dict = {"targets": [], "failures": [], "passed": 0, "failed": 0}

    def result(ok: bool, binary: dict | None, errors: list, code: int) -> int:
        return _emit(_envelope("test", ok, binary, errors, data), code)

    missing = _missing_files(
        [("test target", target)] + [("resources file", r) for r in resources] + [("env file", env_file)]
    )
    if missing:
        return result(False, None, missing, EXIT_ENV)
    found, code = _binary_or_error("test", data)
    if found is None:
        return code
    binary = _public(found)

    cmd = [*found["argv"], "test"]
    for res in resources:
        cmd += ["--resources", escape_glob(res)]
    if env_file:
        cmd += ["--env-file", env_file]
    cmd.append(escape_glob(target))
    try:
        returncode, out, err = _run_io(cmd, CHECK_TIMEOUT_S)
    except OSError as exc:
        return result(False, binary, [_error(f"could not run test: {exc}")], EXIT_ENV)
    if returncode is None:
        return result(False, binary, [_error(f"test timed out after {CHECK_TIMEOUT_S}s")], EXIT_ENV)

    text = strip_ansi(f"{out}\n{err}")
    parsed = parse_test_output(strip_ansi(out))
    from_err = parse_test_output(strip_ansi(err))
    parsed["targets"].update(from_err["targets"])
    parsed["failures"] += from_err["failures"]
    parsed["init_errors"] += from_err["init_errors"]
    parsed["no_tests"] = parsed["no_tests"] or from_err["no_tests"]
    data["targets"] = [{"file": f, "passed": p} for f, p in parsed["targets"].items()]
    data["failures"] = parsed["failures"]
    data["passed"] = sum(1 for p in parsed["targets"].values() if p)
    data["failed"] = sum(1 for p in parsed["targets"].values() if not p)
    errors = [
        _error(
            f"{f['case']}" + (f" [line {f['line']}]" if f["line"] is not None else "")
            + (f": {f['message'].splitlines()[0]}" if f["message"] else ""),
            file=f["target"],
        )
        for f in parsed["failures"]
    ]
    errors += parsed["init_errors"]
    if parsed["no_tests"]:
        errors.append(_error(_NO_TESTS, file=target))
    if not errors and data["failed"]:
        errors = [_error(f"test target failed: {t['file']}", file=t["file"]) for t in data["targets"] if not t["passed"]]
    if errors:
        return result(False, binary, errors, EXIT_CHECK_FAILED)
    if returncode != 0:
        tail = _tail(text)
        if tail:
            return result(False, binary, [_error(f"test exited {returncode}: {tail}")], EXIT_CHECK_FAILED)
        return result(False, binary, [_error(f"test exited {returncode} with no output")], EXIT_ENV)
    return result(True, binary, [], EXIT_OK)


def build_parser() -> _Parser:
    parser = _Parser(
        prog="rpcn_check.py",
        description="Run Redpanda Connect checks and print one JSON envelope (schema 1).",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>", parser_class=_Parser)
    sub.required = True
    p_binary = sub.add_parser("binary", help="find the Redpanda Connect binary and report its version")
    p_binary.set_defaults(func=cmd_binary)
    p_lint = sub.add_parser("lint", help="lint pipeline config files")
    p_lint.add_argument("files", nargs="+", metavar="<file>", help="config files to lint")
    p_lint.add_argument(
        "--resources", action="append", metavar="<file>", help="resources file (repeatable)"
    )
    p_lint.add_argument("--env-file", metavar="<file>", help="dotenv file for interpolations")
    p_lint.set_defaults(func=cmd_lint)
    p_hash = sub.add_parser(
        "hash", help="print file sha256 hashes, or check a hand-off file's recorded input hashes"
    )
    p_hash.add_argument("files", nargs="*", metavar="<file>", help="files to hash")
    p_hash.add_argument(
        "--check", metavar="<handoff.md>", help="check this hand-off file's header and input hashes"
    )
    p_hash.set_defaults(func=cmd_hash)

    p_blobl = sub.add_parser("blobl", help="run a Bloblang mapping over JSON lines, or check it against its samples")
    p_blobl.add_argument("mapping", metavar="<mapping>", help="Bloblang mapping file")
    blobl_in = p_blobl.add_mutually_exclusive_group()
    blobl_in.add_argument("--input", metavar="<file>", help="input file, one JSON document per line")
    blobl_in.add_argument(
        "--samples", metavar="<file>", help="a <name>.samples.json: run and compare this mapping's samples"
    )
    p_blobl.add_argument("--env-file", metavar="<file>", help="dotenv file for env() lookups")
    p_blobl.set_defaults(func=cmd_blobl)

    p_list = sub.add_parser("list", help="list the components of a category")
    p_list.add_argument("category", metavar="<category>", help="for example inputs, processors, outputs")
    p_list.add_argument("--status", choices=LIST_STATUSES, help="only components with this status")
    p_list.set_defaults(func=cmd_list)

    p_fields = sub.add_parser("fields", help="list a component's config fields from the installed binary")
    p_fields.add_argument("category", metavar="<category>", help="for example inputs, processors, outputs")
    p_fields.add_argument("component", metavar="<component>", help="component name, for example generate")
    p_fields.set_defaults(func=cmd_fields)

    p_run = sub.add_parser("run", help="dry-run a pipeline config, bounded by --timeout")
    p_run.add_argument("config", metavar="<config>", help="pipeline config file")
    p_run.add_argument("--input", metavar="<file>", help="file passed to the pipeline as stdin")
    p_run.add_argument(
        "--resources", action="append", metavar="<file>", help="resources file (repeatable)"
    )
    p_run.add_argument("--env-file", metavar="<file>", help="dotenv file for interpolations")
    p_run.add_argument(
        "--bounded", action="store_true",
        help="replace the config's input with stdin and its output with stdout (needs --input)",
    )
    p_run.add_argument(
        "--timeout", type=_positive_float, default=RUN_TIMEOUT_S, metavar="<s>",
        help=f"seconds before the run is stopped (default {RUN_TIMEOUT_S:g})",
    )
    p_run.set_defaults(func=cmd_run)

    p_test = sub.add_parser("test", help="run `rpk connect test` cases")
    p_test.add_argument(
        "target", metavar="<target>", help="a config, or a <name>_benthos_test.yaml file"
    )
    p_test.add_argument(
        "--resources", action="append", metavar="<file>", help="resources file (repeatable)"
    )
    p_test.add_argument("--env-file", metavar="<file>", help="dotenv file for interpolations")
    p_test.set_defaults(func=cmd_test)
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = build_parser()
    try:
        args, extra = parser.parse_known_args(argv)
        # `lint a.yaml --resources r.yaml b.yaml`: argparse leaves `b.yaml` over,
        # because positionals are taken in one run. Keep later file arguments.
        if extra and isinstance(getattr(args, "files", None), list) and not any(
            e.startswith("-") for e in extra
        ):
            args.files.extend(extra)
        elif extra:
            parser.error(f"unrecognized arguments: {' '.join(extra)}")
    except _ParserExit as exc:  # --help on any parser: help already on stderr
        return exc.status
    except UsageError as exc:
        command = argv[0] if argv and not argv[0].startswith("-") else ""
        return _emit(_envelope(command, False, None, [_error(str(exc))], {}), EXIT_ENV)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
