"""Launchers must reject upstream-only addons before building or starting Fura."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NativePreflight(unittest.TestCase):
    def test_missing_process_identity_never_reaches_bridge_build(self):
        self.check_addon("export class Process {}\n")

    def test_same_version_stale_edit_parser_never_reaches_bridge_build(self):
        self.check_addon(
            "export class Process { identity() {} }\n"
            "export function editInspect() { return { paths: [], entries: [], fileOps: [] }; }\n",
        )

    def test_current_edit_parser_reaches_bridge_build(self):
        self.check_addon(
            "export class Process { identity() {} }\n"
            "export function editInspect(mode, payload) {\n"
            " const { input } = JSON.parse(payload);\n"
            " const match = input.match(/^\\*\\*\\* Edit File: (.+)\\n\\*\\*\\* Find\\nold\\n\\*\\*\\* Replace\\nnew\\n$/);\n"
            " if (mode !== 'sloppy' || !match) throw new Error('Unsupported edit payload');\n"
            " return { paths: [match[1]], entries: [], fileOps: [] };\n"
            "}\n",
            build_allowed=True,
        )

    def check_addon(self, module, *, build_allowed=False):
        bun = os.environ.get("BUN_BIN") or shutil.which("bun")
        if bun is None:
            self.skipTest("bun is required for the real addon-import preflight")
        for launcher in ("run-local-omp.sh", "run-local-with-tailscale.sh"):
            with self.subTest(launcher=launcher), tempfile.TemporaryDirectory(prefix="fura-native-preflight-") as temp:
                directory = Path(temp)
                for name in (launcher, "fura-env.sh"):
                    shutil.copyfile(ROOT / name, directory / name)
                omp = directory / "vendor/oh-my-pi"
                agent = omp / "packages/coding-agent"
                native = agent / "node_modules/@oh-my-pi/pi-natives"
                native.mkdir(parents=True)
                (agent / "src").mkdir()
                (omp / ".git").touch()
                (omp / "package.json").write_text('{"packageManager":"bun@1.4.0"}')
                (omp / "packages/natives/native").mkdir(parents=True)
                (omp / "packages/natives/package.json").write_text('{"version":"1.0.0"}')
                # Glob and version checks pass; exercise the incompatible native behavior.
                platform = subprocess.check_output([bun, "-e", "process.stdout.write(`${process.platform}-${process.arch}`)"], text=True)
                (omp / f"packages/natives/native/pi_natives.{platform}.node").touch()
                (native / "package.json").write_text('{"type":"module","main":"index.js"}')
                (native / "index.js").write_text(
                    "export function __piNativesV1_0_0() {}\nexport function editDescription() {}\n" + module
                )
                (agent / "src/cli.ts").write_text("process.stdout.write('1.0.0');\n")
                marker = directory / "bridge-build-started"
                cargo = directory / "cargo"
                cargo.write_text(f'#!/bin/sh\ntouch "{marker}"\nexit 1\n')
                cargo.chmod(0o700)
                tailscale = directory / "tailscale"
                tailscale.write_text("#!/bin/sh\necho 127.0.0.1\n")
                tailscale.chmod(0o700)
                certificate = directory / "test-cert"
                certificate.touch()
                config = directory / ".env"
                config.write_text("\n".join([
                    f"BUN_BIN={bun}", f"FURA_DIR={directory}", "FURA_TOKEN=fixture-only",
                    "FURA_LOCAL_BIND=127.0.0.1:38999", "FURA_REMOTE_PORT=38998",
                    "FURA_REMOTE_HOST=localhost", f"FURA_TLS_CERT={certificate}",
                    f"FURA_TLS_KEY={certificate}", f"FURA_BRIDGE_DEBUG_FILE={directory}/bridge.jsonl",
                    f"FURA_EVENT_DEBUG_FILE={directory}/events.jsonl", "FURA_SKIP_FRONTEND_BUILD=1",
                    "FURA_TEXTILE_REDMINE_ROOT_URL=https://redmine.example.test",
                ]))
                environment = {k: v for k, v in os.environ.items() if not k.startswith("FURA_")}
                environment["PATH"] = f"{directory}:{environment['PATH']}"
                result = subprocess.run(["bash", str(directory / launcher)], env=environment,
                                        capture_output=True, text=True, timeout=15)
                # Fake cargo always fails; reaching it means native preflight accepted the addon.
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(marker.exists(), build_allowed, result.stderr)


if __name__ == "__main__":
    unittest.main()
