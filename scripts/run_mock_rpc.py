"""Run the mock bridge without reading production .env or sharing writable data."""
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile

from smoke_process import OwnedProcess

ROOT = Path(__file__).resolve().parents[1]


def workload(directory, port, extra):
    static = Path(directory) / "frontend-dist"
    subprocess.run(["npm", "--prefix", str(ROOT / "frontend"), "run", "build", "--",
                    "--outDir", str(static)], cwd=ROOT, check=True)
    os.execvp("cargo", ["cargo", "run", "--locked", "--manifest-path", str(ROOT / "Cargo.toml"),
                       "--bin", "fura", "--",
                       "--bind", f"127.0.0.1:{port}", "--static-dir", str(static),
                       "--session-root", str(Path(directory) / "sessions"),
                       "--rpc-program", shutil.which("node"), "--no-default-rpc-args",
                       "--rpc-arg", str(ROOT / "fixtures/mock-omp-rpc.mjs"), *extra])


def main():
    if sys.argv[1:2] == ["--workload"]:
        workload(sys.argv[2], int(sys.argv[3]), sys.argv[4:])
        return 0
    port = int(os.environ.get("FURA_SMOKE_PORT", "38737"))
    if not 1 <= port <= 65535:
        raise ValueError("smoke port must be in 1..65535")
    # Fail rather than attach to any existing server. The bridge must still
    # bind for itself; a race here produces a startup error, never reuse.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    directory = Path(tempfile.mkdtemp(prefix="fura-mock-"))
    environment = {key: value for key, value in os.environ.items() if not key.startswith("FURA_")}
    real_home = Path.home()
    for name in ("home", "sessions", "cache", "config", "data", "state", "runtime", "tmp"):
        (directory / name).mkdir(mode=0o700)
    environment.update(
        HOME=str(directory / "home"), FURA_TOKEN="dev", CARGO_TARGET_DIR=str(directory / "target"),
        CARGO_HOME=os.environ.get("CARGO_HOME", str(real_home / ".cargo")),
        RUSTUP_HOME=os.environ.get("RUSTUP_HOME", str(real_home / ".rustup")),
        RUSTC_WRAPPER="", TMPDIR=str(directory / "tmp"),
        XDG_CACHE_HOME=str(directory / "cache"), XDG_CONFIG_HOME=str(directory / "config"),
        XDG_DATA_HOME=str(directory / "data"), XDG_STATE_HOME=str(directory / "state"),
        XDG_RUNTIME_DIR=str(directory / "runtime"),
    )
    owned = None

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(signum)

    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    for signum in signals:
        signal.signal(signum, interrupted)
    try:
        signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        try:
            owned = OwnedProcess([sys.executable, __file__, "--workload", str(directory),
                                  str(port), *sys.argv[1:]], directory / "process", cwd=directory,
                                 env=environment)
        finally:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, signals)
        return owned.wait()
    except KeyboardInterrupt as error:
        return 128 + error.args[0]
    finally:
        for signum in signals:
            signal.signal(signum, signal.SIG_IGN)
        if owned is not None:
            owned.cleanup()
        # A refused cleanup raises before deletion: retain its ownership record.
        shutil.rmtree(directory)


if __name__ == "__main__":
    sys.exit(main())
