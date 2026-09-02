import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PYTHON_PACKAGE = ROOT / "python"
BACKEND_BUNDLE = ROOT / "node" / "dist" / "codex-chatgpt-control-backend.mjs"
FAKE_BACKEND = PYTHON_PACKAGE / "tests" / "fixtures" / "fake_backend.py"


class LiveBackendSmokeTests(unittest.TestCase):
    def test_ordinary_shell_smoke_returns_documented_browser_bridge_blocker(self) -> None:
        self.assertTrue(BACKEND_BUNDLE.exists(), "Run npm run bundle:backend before live backend smoke tests.")

        completed = subprocess.run(
            [sys.executable, "scripts/live_smoke.py", "--mode", "ordinary-shell"],
            cwd=PYTHON_PACKAGE,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        summary = json.loads(completed.stdout)
        self.assertEqual(summary["mode"], "ordinary-shell")
        self.assertEqual(summary["health"]["status"], "ok")
        self.assertGreater(summary["commandsCount"], 0)
        self.assertIn(summary["runnerRun"]["status"], {"blocked", "partial", "error"})
        self.assertEqual(summary["runnerRun"]["blocker"]["kind"], "browser_bridge_unavailable")

    def test_browser_bridge_mode_runs_against_explicit_backend_without_raw_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_dir = Path(tmp) / "reports"

            completed = subprocess.run(
                [
                    sys.executable,
                    "scripts/live_smoke.py",
                    "--mode",
                    "browser-bridge",
                    "--backend-command",
                    f'"{sys.executable}" "{FAKE_BACKEND}"',
                    "--report-dir",
                    str(report_dir),
                ],
                cwd=PYTHON_PACKAGE,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("reply with the word hi", completed.stdout)
        self.assertNotIn("pythonbrowserbridgesecret", completed.stdout)

        summary = json.loads(completed.stdout)
        self.assertEqual(summary["mode"], "browser-bridge")
        self.assertEqual(summary["status"], "pass")
        self.assertEqual(summary["privacy"]["rawPromptPersisted"], False)
        self.assertEqual(summary["privacy"]["rawResponsePersisted"], False)
        self.assertEqual([scenario["status"] for scenario in summary["scenarios"]], ["pass"] * 5)


if __name__ == "__main__":
    unittest.main()
