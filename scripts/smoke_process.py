"""POSIX smoke-process ownership. PID files describe ownership, never grant it."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def process_table():
    # Real ownership is stable across setuid helpers (macOS /bin/ps itself).
    output = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid=,pgid=,ruid=,lstart=,stat="], text=True
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
        self.cleanup_file = self.directory / "cleanup.json"
        if any(path.exists() for path in (self.pid_file, self.result_file, self.cleanup_file)):
            raise OwnershipError("refusing an existing process/PID record")
        self.protected = {pid: identity(row) for pid, row in process_table().items()}
        self.closed = False
        self.observed = {}
        # The child cannot start the workload until ownership is established.
        # EOF on a failed handoff exits the supervisor without any PID discovery
        # or signaling. Its live Popen pins the dedicated PID/PGID thereafter.
        read_fd, write_fd = os.pipe()
        previous_mask = signal.pthread_sigmask(
            signal.SIG_BLOCK, (signal.SIGTERM, signal.SIGINT, signal.SIGHUP),
        )
        try:
            self.process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--supervisor",
                 str(self.result_file), str(read_fd), "--", *command],
                cwd=cwd, env=env, start_new_session=True, pass_fds=(read_fd,),
            )
            rows = process_table()
            row = rows.get(self.process.pid)
            if row is None:
                raise OwnershipError("supervisor disappeared before ownership was established")
            self.record = dict(owner=identity(rows[os.getpid()]),
                               leader=identity(row), pgid=row["pgid"],
                               sid=os.getsid(self.process.pid))
            with self.pid_file.open("x") as output:
                json.dump(self.record, output)
            self._verified_group()
            os.write(write_fd, b"1")
        except BaseException:
            os.close(write_fd)
            write_fd = None
            if hasattr(self, "process"):
                self.process.wait(timeout=5)
            raise
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

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
        self._observe_descendants(rows)
        return members

    def _observe_descendants(self, rows):
        # Discovery is evidence only, never authority to signal individual PIDs.
        # Retain identities so an observed child remains reportable after reparenting.
        descendants = {
            pid for pid, expected in self.observed.items()
            if pid in rows and identity(rows[pid]) == expected
        }
        descendants.add(self.process.pid)
        pending = list(rows.values())
        while pending:
            found = [row for row in pending
                     if row["pgid"] == self.process.pid or row["ppid"] in descendants]
            if not found:
                break
            for row in found:
                descendants.add(row["pid"])
                self.observed[row["pid"]] = identity(row)
            pending = [row for row in pending if row["pid"] not in descendants]

    def _report_cleanup(self):
        deadline = time.monotonic() + 5
        while True:
            rows = process_table()
            remaining = [
                {**expected, "pgid": rows[pid]["pgid"]}
                for pid, expected in self.observed.items()
                if pid in rows and identity(rows[pid]) == expected
                and not rows[pid]["state"].startswith("Z")
            ]
            group_cleaned = not any(row["pgid"] == self.process.pid for row in remaining)
            if group_cleaned or time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        # No argv, environment, prompts, or credentials in retained evidence.
        temporary = self.cleanup_file.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "owner": self.record["owner"], "leader": self.record["leader"],
            "group_cleaned": group_cleaned, "remaining_observed_descendants": remaining,
            "observed_descendants": list(self.observed.values()),
            "scope": "process-group-only; unobserved detached descendants cannot be excluded",
        }, indent=2))
        temporary.replace(self.cleanup_file)
        if remaining:
            raise OwnershipError(
                "owned group signaled, but observed descendants escaped or survived; "
                f"refusing PID-only cleanup; inspect {self.cleanup_file}"
            )

    def cleanup(self, grace=0.5):
        if self.closed:
            self._report_cleanup()
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
            self._report_cleanup()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                self._verified_group()
                if self.result_file.exists():
                    return json.loads(self.result_file.read_text())["exit_code"]
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError("isolated command timed out")
                time.sleep(0.02)
        finally:
            self.cleanup()


def supervise(result_file, read_fd, command):
    # Caught handlers reset to SIG_DFL on exec: workloads receive TERM/INT,
    # while this identity anchor survives until the owner's final KILL.
    signal.signal(signal.SIGTERM, lambda *_: None)
    signal.signal(signal.SIGINT, lambda *_: None)
    signal.signal(signal.SIGHUP, lambda *_: None)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, (signal.SIGTERM, signal.SIGINT, signal.SIGHUP))
    try:
        if os.read(read_fd, 1) != b"1":
            return
    finally:
        os.close(read_fd)
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
        supervise(sys.argv[2], int(sys.argv[3]), sys.argv[5:])
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
