"""Run a finite BTW browser gate with an identity-checked, disposable Fura.

Requires a separately built binary/static tree and prepared private runtime.
Never discovers credentials, builds, resumes production sessions, or uses live
launch helpers. Mock fault injection and real-provider mode remain separate.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

from smoke_process import OwnedProcess

REPO = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--static-dir", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--mode", choices=("mock", "real"), required=True)
    parser.add_argument("--test-filter")
    args = parser.parse_args()
    runtime = Path(args.runtime).resolve()
    evidence = Path(args.evidence).resolve()
    binary = Path(args.binary).resolve()
    static = Path(args.static_dir).resolve()
    for location in (runtime, evidence, binary, static):
        if location == REPO or REPO in location.parents:
            raise ValueError("runtime, evidence, binary and static output must be outside the source repository")
    if not binary.is_file() or not (static / "index.html").is_file() or not (runtime / "sessions").is_dir():
        raise ValueError("prepare isolated build and session fixtures first")
    evidence.mkdir(parents=True, exist_ok=True)
    environment = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(runtime / "home"),
                   "TMPDIR": str(runtime / "tmp"), "XDG_CONFIG_HOME": str(runtime / "config"),
                   "XDG_DATA_HOME": str(runtime / "data"), "XDG_STATE_HOME": str(runtime / "state"),
                   "XDG_CACHE_HOME": str(runtime / "cache"), "PI_CODING_AGENT_DIR": str(runtime / "home/.omp/agent"),
                   "FURA_TOKEN": "btw-fixture-only", "RUST_LOG": "info", "PYTHONDONTWRITEBYTECODE": "1",
                   "NODE_OPTIONS": "--no-experimental-webstorage", "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull, "GIT_TERMINAL_PROMPT": "0"}
    for name in ("home", "tmp", "cache", "config", "data", "state", "cwd"):
        (runtime / name).mkdir(parents=True, exist_ok=True)
    node = shutil.which("node", path=environment["PATH"])
    if not node:
        raise RuntimeError("node unavailable")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    command = [str(binary), "--bind", f"127.0.0.1:{port}", "--static-dir", str(static),
               "--session-root", str(runtime / "sessions"), "--no-default-rpc-args", "--skip-rls-unavailable"]
    if args.mode == "mock":
        environment["FURA_BTW_FIXTURE_ROOT"] = str(runtime)
        command += ["--rpc-program", node, "--rpc-arg", str(REPO / "fixtures/btw-omp-rpc.mjs")]
    else:
        bun = shutil.which("bun", path=environment["PATH"])
        if not bun or not (runtime / "home/.omp/agent/agent.db").is_file():
            raise ValueError("real mode requires an explicitly prepared private credential store and bun")
        environment["FURA_BTW_WITNESS"] = str(runtime / "provider-witness.jsonl")
        command += ["--rpc-program", bun]
        rpc_args = [str(REPO / "vendor/oh-my-pi/packages/coding-agent/src/cli.ts"), "--mode", "rpc-ui",
                    "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-prewalk",
                    "--tools", "read", "--thinking", "off", "--system-prompt", str(runtime / "system.md"),
                    "--trusted-extension", str(runtime / "witness.mjs")]
        command += [f"--rpc-arg={value}" for value in rpc_args]
    generation = uuid.uuid4().hex
    server = None
    test_process = None
    code = 1

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(signum)

    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    for signum in signals:
        signal.signal(signum, interrupted)
    try:
        saved_out, saved_err = os.dup(1), os.dup(2)
        try:
            with (runtime / f"bridge-{generation}.log").open("wb") as log:
                os.dup2(log.fileno(), 1)
                os.dup2(log.fileno(), 2)
                previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
                try:
                    server = OwnedProcess(command, runtime / f"server-{generation}", cwd=runtime / "cwd", env=environment)
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        finally:
            os.dup2(saved_out, 1)
            os.dup2(saved_err, 2)
            os.close(saved_out)
            os.close(saved_err)
        local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 30
        while True:
            if server.result_file.exists():
                raise RuntimeError(f"owned Fura exited; inspect private runtime {runtime}")
            listening = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"], capture_output=True, text=True)
            listeners = {int(line[1:]) for line in listening.stdout.splitlines() if line.startswith("p")}
            owned = {row["pid"] for row in server._verified_group()}
            if listeners - owned:
                raise RuntimeError("refusing foreign listener")
            if listeners:
                try:
                    with local_http.open(base + "/healthz", timeout=.3) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise TimeoutError("owned Fura readiness deadline")
            time.sleep(.05)
        environment.update({"FURA_BTW_BASE_URL": base, "FURA_BTW_EVIDENCE_DIR": str(evidence),
                            "FURA_BTW_REAL": "1" if args.mode == "real" else "0",
                            "FURA_BTW_RUNTIME": str(runtime)})
        browser_command = [node, str(REPO / "frontend/node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.btw.config.ts"]
        if args.test_filter:
            browser_command += ["--grep", args.test_filter]
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        try:
            test_process = OwnedProcess(browser_command, runtime / f"browser-{generation}", cwd=REPO / "frontend", env=environment)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        code = test_process.wait(timeout=900)
    except KeyboardInterrupt as error:
        code = 128 + (error.args[0] if error.args else signal.SIGINT)
    finally:
        for signum in signals:
            signal.signal(signum, signal.SIG_IGN)
        if test_process is not None:
            test_process.cleanup()
        if server is not None:
            server.cleanup(grace=3)
        (evidence / f"runner-{generation}.json").write_text(json.dumps({"mode": args.mode, "baseURL": base,
            "exit_code": code, "owned_processes_cleaned": True, "production_launchers_used": False,
            "native_os_focus_verified": False}, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
