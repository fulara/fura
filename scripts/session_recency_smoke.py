"""Own disposable Fura restarts for the session-recency browser regression.

JSON commands on stdin: restart, append, touch, stop. Only seeded fixture files
can be changed. This runner never builds, uses production data, or stops a PID
it did not create. The caller retains the temporary evidence directory.
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
import tempfile
import time
import urllib.request

from smoke_process import OwnedProcess

REPO = Path(__file__).resolve().parents[1]


def isolated_environment(root):
    environment = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(root / "home"),
        "TMPDIR": str(root / "tmp"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_STATE_HOME": str(root / "state"),
        "FURA_TOKEN": "recency-fixture-only",
        "FURA_RECENCY_FIXTURE_ROOT": str(root),
        "RUST_LOG": "warn",
        "PYTHONDONTWRITEBYTECODE": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
    }
    for name in ("home", "tmp", "cache", "config", "data", "state", "sessions", "cwd"):
        (root / name).mkdir()
    return environment


def seed_sessions(root, fixtures):
    paths = {}
    for fixture in fixtures:
        name = fixture["name"]
        if not name or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for character in name):
            raise ValueError("fixture name must be a simple lowercase identifier")
        if name in paths:
            raise ValueError("duplicate fixture name")
        path = root / "sessions" / (name + ".jsonl")
        records = fixture["records"]
        if not records or records[0].get("type") != "session":
            raise ValueError("fixture must begin with its session header")
        records[0]["cwd"] = str(root / "cwd")
        path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
        if "mtimeMs" in fixture:
            nanoseconds = int(fixture["mtimeMs"] * 1_000_000)
            os.utime(path, ns=(nanoseconds, nanoseconds))
        paths[name] = path
    return paths


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--static-dir", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--output-parent", required=True)
    parser.add_argument("--rpc-script", default=str(REPO / "fixtures" / "mock-omp-rpc.mjs"))
    options = parser.parse_args()
    parent = Path(options.output_parent).resolve()
    if parent == REPO or REPO in parent.parents:
        raise ValueError("fixture output must be outside the repository")
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="recency-runtime-", dir=parent))
    environment = isolated_environment(root)
    paths = seed_sessions(root, json.loads(Path(options.fixtures).read_text(encoding="utf-8")))
    node = shutil.which("node", path=environment["PATH"])
    if node is None:
        raise RuntimeError("node is required for the isolated RPC fixture")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    owned = None
    generation = 0

    def stop():
        nonlocal owned
        if owned is not None:
            owned.cleanup(grace=2)
            owned = None

    def start():
        nonlocal owned, generation
        generation += 1
        command = [str(Path(options.binary).resolve()), "--bind", f"127.0.0.1:{port}",
                   "--static-dir", str(Path(options.static_dir).resolve()),
                   "--session-root", str(root / "sessions"), "--rpc-program", node,
                   "--no-default-rpc-args", "--rpc-arg", str(Path(options.rpc_script).resolve()),
                   "--bridge-debug-file", str(root / f"catalog-{generation}.jsonl"),
                   "--skip-rls-unavailable"]
        # Keep the command protocol separate from child/supervisor output.
        saved_out, saved_err = os.dup(1), os.dup(2)
        try:
            with (root / f"bridge-{generation}.log").open("wb") as log:
                os.dup2(log.fileno(), 1)
                os.dup2(log.fileno(), 2)
                previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGTERM, signal.SIGINT, signal.SIGHUP))
                try:
                    owned = OwnedProcess(command, root / f"process-{generation}", cwd=root / "cwd", env=environment)
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        finally:
            os.dup2(saved_out, 1)
            os.dup2(saved_err, 2)
            os.close(saved_out)
            os.close(saved_err)
        deadline = time.monotonic() + 20
        lsof = shutil.which("lsof", path=environment["PATH"])
        if lsof is None:
            raise RuntimeError("lsof is required to verify ownership of the fixture listener")
        local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            if owned.result_file.exists():
                raise RuntimeError(f"owned fixture exited before readiness; inspect {root}")
            listeners = subprocess.run([lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"],
                                       capture_output=True, text=True, check=False)
            listener_pids = {int(line[1:]) for line in listeners.stdout.splitlines() if line.startswith("p")}
            owned_pids = {row["pid"] for row in owned._verified_group()}
            if listener_pids - owned_pids:
                raise RuntimeError("refusing a listener not owned by this fixture")
            if listener_pids:
                try:
                    with local_http.open(base + "/healthz", timeout=.3) as response:
                        if response.status == 200 and not owned.result_file.exists():
                            return
                except (OSError, ValueError):
                    pass
            if time.monotonic() >= deadline:
                raise RuntimeError(f"fixture did not become ready; inspect {root}")
            time.sleep(.025)

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(signum)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        start()
        emit({"event": "ready", "baseURL": base, "root": str(root), "generation": generation,
              "sessionFiles": {name: str(path) for name, path in paths.items()}})
        for line in sys.stdin:
            command = json.loads(line)
            operation = command.get("op")
            if operation == "stop":
                break
            if operation == "restart":
                stop()
                start()
            elif operation in ("append", "touch"):
                path = paths[command["name"]]
                if operation == "append":
                    with path.open("a", encoding="utf-8") as output:
                        output.write(json.dumps(command["entry"], ensure_ascii=False) + "\n")
                if "mtimeMs" in command:
                    nanoseconds = int(command["mtimeMs"] * 1_000_000)
                    os.utime(path, ns=(nanoseconds, nanoseconds))
            else:
                raise ValueError("unsupported recency fixture operation")
            emit({"event": "complete", "op": operation, "generation": generation})
    finally:
        stop()
        emit({"event": "stopped", "ownedProcessesCleaned": True, "root": str(root)})


if __name__ == "__main__":
    main()
