import json
import os
from pathlib import Path
import subprocess
import signal
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
import time

from scripts.smoke_process import OwnedProcess, OwnershipError, identity, process_table

ROOT = Path(__file__).resolve().parents[1]


class MockLauncherIsolation(unittest.TestCase):
    def test_launcher_does_not_share_its_callers_group_or_home(self):
        # Fake cargo is harmless: never run the old launcher's cleanup or signal
        # the caller. The real launch path must isolate even a quick command.
        with tempfile.TemporaryDirectory(prefix="fura-launcher-regression-") as temp:
            directory = Path(temp)
            cargo = directory / "cargo"
            cargo.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "if 'run' in sys.argv:\n"
                " print(json.dumps({'pgid':os.getpgrp(),'sid':os.getsid(0),'home':os.environ['HOME'],"
                "'parent_context':[key for key in os.environ if key.startswith('PI_')]}))\n"
            )
            cargo.chmod(0o700)
            npm = directory / "npm"
            npm.write_text("#!/bin/sh\nexit 0\n")
            npm.chmod(0o700)
            config = directory / "env"
            config.write_text(f"FURA_DIR={ROOT}\nFURA_PORT=38999\nFURA_TOKEN=dev\n")
            with socket.socket() as reserve:
                reserve.bind(("127.0.0.1", 0))
                port = reserve.getsockname()[1]
            result = subprocess.run(
                ["bash", str(ROOT / "run-mock-rpc.sh")],
                env={**os.environ, "PATH":f"{directory}:{os.environ['PATH']}",
                     "FURA_ENV_FILE":str(config), "FURA_SKIP_FRONTEND_BUILD":"1",
                     "FURA_SMOKE_PORT":str(port),
                     **{key: "fixture-only" for key in (
                         "PI_CODING_AGENT_DIR", "PI_SESSION_FILE", "PI_ARTIFACTS_DIR",
                         "PI_TOOL_BRIDGE_URL", "PI_TOOL_BRIDGE_TOKEN", "PI_TOOL_BRIDGE_SESSION",
                         "PI_EVAL_LOCAL_ROOTS", "PI_PROFILE",
                     )}},
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            child = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertNotEqual(child["pgid"], os.getpgrp())
            self.assertNotEqual(child["sid"], os.getsid(0))
            self.assertNotEqual(child["home"], os.environ["HOME"])
            self.assertEqual(child["parent_context"], [], "mock workload must not inherit OMP state or capabilities")

    def test_partial_startup_failure_preserves_ownership_evidence(self):
        with tempfile.TemporaryDirectory(prefix="fura-startup-regression-") as temp:
            directory = Path(temp) / "retained"
            directory.mkdir()
            with socket.socket() as reserve:
                reserve.bind(("127.0.0.1", 0))
                port = reserve.getsockname()[1]
            source = (
                "import sys\n"
                "from unittest.mock import patch\n"
                f"sys.path.insert(0, {str(ROOT / 'scripts')!r})\n"
                "import run_mock_rpc\n"
                "def partial_start(*args, **kwargs):\n"
                " path = run_mock_rpc.Path(args[1]); path.mkdir()\n"
                " (path / 'process.json').write_text('partial ownership evidence')\n"
                " raise RuntimeError('ownership handshake failed')\n"
                f"with patch.object(run_mock_rpc.tempfile, 'mkdtemp', return_value={str(directory)!r}), "
                "patch.object(run_mock_rpc, 'OwnedProcess', side_effect=partial_start):\n"
                " run_mock_rpc.main()\n"
            )
            result = subprocess.run(
                [sys.executable, "-c", source],
                env={**os.environ, "FURA_SMOKE_PORT": str(port)},
                capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((directory / "process/process.json").read_text(), "partial ownership evidence")
            self.assertIn(str(directory), result.stderr)


class OwnedProcessLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fura-owned-regression-")
        self.directory = Path(self.temp.name)
        self.sentinel = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True,
        )
        self.sentinel_identity = identity(process_table()[self.sentinel.pid])
        self.owned = None

    def tearDown(self):
        try:
            if self.owned is not None:
                self.owned.cleanup()
            self.assertIsNone(self.sentinel.poll(), "protected sentinel must survive")
            self.assertEqual(identity(process_table()[self.sentinel.pid]), self.sentinel_identity)
        finally:
            if self.sentinel.poll() is None:
                self.sentinel.terminate()
            self.sentinel.wait(timeout=5)
            self.temp.cleanup()

    def workload(self, mode="wait"):
        ready = self.directory / "ready.json"
        source = (
            "import json, os, pathlib, signal, subprocess, sys, time\n"
            "signal.signal(signal.SIGTERM, lambda *_: None)\n"
            "worker = subprocess.Popen([sys.executable, '-c', "
            "'import signal,time; signal.signal(signal.SIGTERM, lambda *_: None); time.sleep(60)'])\n"
            f"pathlib.Path({str(ready)!r}).write_text(json.dumps([os.getpid(),worker.pid]))\n"
            + ("time.sleep(0.1)\n" if mode == "exit" else "time.sleep(60)\n")
        )
        return [sys.executable, "-c", source], ready

    def await_ready(self, ready):
        deadline = time.monotonic() + 5
        while not ready.exists():
            if time.monotonic() >= deadline:
                self.fail("workload did not reach its handshake")
            time.sleep(0.01)
        pids = json.loads(ready.read_text())
        table = process_table()
        return {pid: identity(table[pid]) for pid in pids}

    def assert_gone(self, identities):
        deadline = time.monotonic() + 5
        while True:
            rows = process_table()
            live = [pid for pid, expected in identities.items() if pid in rows
                    and identity(rows[pid]) == expected and not rows[pid]["state"].startswith("Z")]
            if not live:
                return
            if time.monotonic() >= deadline:
                self.fail(f"owned workload survived cleanup: {live}")
            time.sleep(0.02)

    def start(self, mode="wait"):
        command, ready = self.workload(mode)
        self.owned = OwnedProcess(command, self.directory / "process")
        pids = self.await_ready(ready)
        self.assertNotEqual(os.getsid(self.owned.process.pid), os.getsid(0))
        self.assertNotEqual(os.getpgid(self.owned.process.pid), os.getpgrp())
        return pids

    def test_normal_exit_reaps_worker_and_repeated_cleanup_is_safe(self):
        pids = self.start("exit")
        self.assertEqual(self.owned.wait(timeout=5), 0)
        self.owned.cleanup()
        self.assert_gone(pids)

    def test_timeout_reaps_command_and_worker(self):
        pids = self.start()
        with self.assertRaises(TimeoutError):
            self.owned.wait(timeout=0.1)
        self.assert_gone(pids)

    def test_failed_start_reaps_supervisor(self):
        self.owned = OwnedProcess([str(self.directory / "missing-executable")], self.directory / "process")
        supervisor = self.owned.process
        self.assertEqual(self.owned.wait(timeout=5), 127)
        self.assertIsNotNone(supervisor.returncode)

    def test_cleanup_signal_before_supervisor_bootstrap_preserves_anchor(self):
        ready = self.directory / "bootstrap-ready"
        release = self.directory / "bootstrap-release"
        bootstrap = (
            "import pathlib, runpy, sys, time\n"
            f"pathlib.Path({str(ready)!r}).touch()\n"
            f"while not pathlib.Path({str(release)!r}).exists(): time.sleep(0.01)\n"
            "sys.argv.pop(0)\n"
            "runpy.run_path(sys.argv[0], run_name='__main__')\n"
        )
        popen = subprocess.Popen

        def delayed_supervisor(command, **kwargs):
            if "--supervisor" in command:
                command = [sys.executable, "-c", bootstrap, *command[1:]]
            return popen(command, **kwargs)

        with patch("scripts.smoke_process.subprocess.Popen", side_effect=delayed_supervisor):
            self.owned = OwnedProcess(
                [sys.executable, "-c", "pass"], self.directory / "process",
            )
        deadline = time.monotonic() + 5
        try:
            while not ready.exists():
                if time.monotonic() >= deadline:
                    self.fail("supervisor did not reach its bootstrap handshake")
                time.sleep(0.01)
            # Signal only the tracked dummy child, never a discovered PID/group.
            self.owned.process.send_signal(signal.SIGTERM)
            time.sleep(0.05)
            self.assertIsNone(self.owned.process.poll(), "supervisor must survive before handlers exist")
        finally:
            release.touch()
        self.assertEqual(self.owned.wait(timeout=5), 0)

    def test_missing_invalid_foreign_and_stale_pid_files_refuse_cleanup(self):
        pids = self.start()
        original = self.owned.pid_file.read_text()
        try:
            for replacement in (
                None,
                "invalid ownership record",
                json.dumps({**self.owned.record, "leader": self.sentinel_identity}),
                json.dumps({**self.owned.record, "leader": {**self.owned.record["leader"], "started": "old"}}),
            ):
                if replacement is None:
                    self.owned.pid_file.unlink()
                else:
                    self.owned.pid_file.write_text(replacement)
                with self.assertRaises(OwnershipError):
                    self.owned.cleanup()
                self.assertIsNone(self.owned.process.poll())
        finally:
            self.owned.pid_file.write_text(original)
        self.owned.cleanup()
        self.assert_gone(pids)

    def test_shared_group_and_protected_member_refuse_cleanup(self):
        pids = self.start()
        original = self.owned.record.copy()
        try:
            self.owned.record["pgid"] = os.getpgrp()
            self.owned.pid_file.write_text(json.dumps(self.owned.record))
            with self.assertRaises(OwnershipError):
                self.owned.cleanup()
        finally:
            self.owned.record = original
            self.owned.pid_file.write_text(json.dumps(original))
        pid = self.owned.process.pid
        self.owned.protected[pid] = original["leader"]
        try:
            with self.assertRaises(OwnershipError):
                self.owned.cleanup()
        finally:
            del self.owned.protected[pid]
        self.owned.cleanup()
        self.assert_gone(pids)

    def test_interrupt_reaps_only_the_interruptible_runners_children(self):
        command, ready = self.workload()
        runner = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts/smoke_process.py"), "--state-dir",
             str(self.directory / "interrupt"), "--", *command], start_new_session=True,
        )
        try:
            pids = self.await_ready(ready)
            runner.send_signal(signal.SIGINT)
            self.assertEqual(runner.wait(timeout=10), 130)
            self.assert_gone(pids)
        finally:
            if runner.poll() is None:
                runner.terminate()
                runner.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
