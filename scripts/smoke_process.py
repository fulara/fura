"""POSIX smoke-process ownership. PID files describe ownership, never grant it."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


def process_table():
    output = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid=,pgid=,uid=,lstart=,stat="], text=True
    )
    rows = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 10:
            pid, ppid, pgid, uid = map(int, fields[:4])
            rows[pid] = dict(pid=pid, ppid=ppid, pgid=pgid, uid=uid,
                             started=" ".join(fields[4:9]), state=fields[9])
    return rows


def identity(row):
    return {key: row[key] for key in ("pid", "uid", "started")}


class OwnershipError(RuntimeError):
    pass


class OwnedProcess:
    def __init__(self, command, directory, *, cwd=None, env=None):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.pid_file = self.directory / "process.json"
        self.result_file = self.directory / "exit.json"
        if self.pid_file.exists() or self.result_file.exists():
            raise OwnershipError("refusing an existing process/PID record")
        self.protected = {pid: identity(row) for pid, row in process_table().items()}
        self.closed = False
        # Keep this session leader alive until cleanup. Its unreaped Popen and
        # live supervisor pin the PID/PGID while children exit or ignore TERM.
        # The child inherits this mask until supervise installs its handlers.
        # Direct OwnedProcess callers need the same startup protection as CLI users.
        previous_mask = signal.pthread_sigmask(
            signal.SIG_BLOCK, (signal.SIGTERM, signal.SIGINT, signal.SIGHUP),
        )
        try:
            self.process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--supervisor",
                 str(self.result_file), uuid.uuid4().hex, "--", *command],
                cwd=cwd, env=env, start_new_session=True,
            )
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        row = process_table().get(self.process.pid)
        if row is None:
            raise OwnershipError("supervisor disappeared before ownership was established")
        self.record = dict(owner=identity(process_table()[os.getpid()]),
                           leader=identity(row), pgid=row["pgid"],
                           sid=os.getsid(self.process.pid))
        with self.pid_file.open("x") as output:
            json.dump(self.record, output)
        self._verified_group()

    def _verified_group(self):
        if self.process.poll() is not None:
            raise OwnershipError("supervisor exited; refusing stale PID/group cleanup")
        try:
            recorded = json.loads(self.pid_file.read_text())
        except (OSError, ValueError) as error:
            raise OwnershipError("missing or invalid ownership record") from error
        if recorded != self.record:
            raise OwnershipError("foreign or stale PID file; cleanup refused")
        rows = process_table()
        if identity(rows[os.getpid()]) != self.record["owner"]:
            raise OwnershipError("cleanup caller does not own this process")
        leader = rows.get(self.process.pid)
        if leader is None or identity(leader) != self.record["leader"]:
            raise OwnershipError("supervisor identity changed")
        pgid = self.record["pgid"]
        if (pgid <= 1 or pgid != self.process.pid or leader["pgid"] != pgid
                or self.record["sid"] != pgid or os.getsid(self.process.pid) != pgid
                or pgid == os.getpgrp()):
            raise OwnershipError("cleanup requires a dedicated session and process group")
        members = [row for row in rows.values() if row["pgid"] == pgid]
        for row in members:
            if self.protected.get(row["pid"]) == identity(row):
                raise OwnershipError("process group contains a protected process")
            if row["uid"] != os.getuid():
                raise OwnershipError("process group contains a foreign owner")
            try:
                if os.getsid(row["pid"]) != pgid:
                    raise OwnershipError("process group ownership is not isolated")
            except ProcessLookupError:
                continue
        return members

    def cleanup(self, grace=0.5):
        if self.closed:
            return
        previous_mask = signal.pthread_sigmask(
            signal.SIG_BLOCK, (signal.SIGTERM, signal.SIGINT, signal.SIGHUP),
        )
        try:
            self._verified_group()
            os.killpg(self.process.pid, signal.SIGTERM)
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                members = self._verified_group()
                if all(row["pid"] == self.process.pid or row["state"].startswith("Z") for row in members):
                    break
                time.sleep(0.02)
            # TERM leaves the supervisor alive, pinning the group's identity
            # until this verified escalation. No PID-only fallback.
            self._verified_group()
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
            self.closed = True
            self.pid_file.unlink()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                if self.result_file.exists():
                    return json.loads(self.result_file.read_text())["exit_code"]
                if self.process.poll() is not None:
                    raise OwnershipError("supervisor exited unexpectedly; inspect remaining resources")
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError("isolated command timed out")
                time.sleep(0.02)
        finally:
            self.cleanup()


def supervise(result_file, command):
    # Caught handlers reset to SIG_DFL on exec: workloads receive TERM/INT,
    # while this identity anchor survives until the owner's final KILL.
    signal.signal(signal.SIGTERM, lambda *_: None)
    signal.signal(signal.SIGINT, lambda *_: None)
    signal.signal(signal.SIGHUP, lambda *_: None)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, (signal.SIGTERM, signal.SIGINT, signal.SIGHUP))
    try:
        code = subprocess.Popen(command).wait()
    except OSError as error:
        print(f"isolated command failed to start: {error}", file=sys.stderr)
        code = 127
    destination = Path(result_file)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps({"exit_code": code}))
    temporary.replace(destination)
    while True:
        signal.pause()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--supervisor":
        supervise(sys.argv[2], sys.argv[5:])
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--timeout", type=float)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")
    owned = None
    previous = {}

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(signum)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        previous[signum] = signal.signal(signum, interrupted)
    try:
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, tuple(previous))
        try:
            owned = OwnedProcess(command, args.state_dir)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        return owned.wait(args.timeout)
    except KeyboardInterrupt as error:
        return 128 + (error.args[0] if error.args else signal.SIGINT)
    except TimeoutError as error:
        print(str(error), file=sys.stderr)
        return 124
    finally:
        # Further interrupts cannot skip the verified, bounded cleanup.
        for signum in previous:
            signal.signal(signum, signal.SIG_IGN)
        try:
            if owned is not None:
                owned.cleanup()
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OwnershipError as error:
        print(f"cleanup refused: {error}", file=sys.stderr)
        sys.exit(125)
