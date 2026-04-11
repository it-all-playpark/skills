#!/usr/bin/env python3
"""Tests for _shared/scripts/detect-stuck-findings.py

Run:
    python3 -m unittest tests/_shared/test-detect-stuck-findings.py -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "_shared" / "scripts" / "detect-stuck-findings.py"


def run_script(history_path: str, extra_args=None):
    args = [sys.executable, str(SCRIPT_PATH), "--history", history_path]
    if extra_args:
        args.extend(extra_args)
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc


def write_history(tmpdir: str, data) -> str:
    path = os.path.join(tmpdir, "plan-review-history.json")
    with open(path, "w") as f:
        json.dump(data, f)
    return path


class TestDetectStuckFindings(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmpdir, ignore_errors=True))

    def assert_script_exists(self):
        self.assertTrue(
            SCRIPT_PATH.exists(),
            f"Script not found at {SCRIPT_PATH}",
        )

    def test_script_exists(self):
        self.assert_script_exists()

    def test_history_missing_returns_no_escalate(self):
        self.assert_script_exists()
        proc = run_script(os.path.join(self.tmpdir, "missing.json"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["escalate"])
        self.assertEqual(result["stuck_findings"], [])

    def test_empty_history_returns_no_escalate(self):
        self.assert_script_exists()
        path = write_history(self.tmpdir, [])
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["escalate"])

    def test_single_iteration_returns_no_escalate(self):
        self.assert_script_exists()
        history = [{
            "iteration": 1,
            "score": 70,
            "verdict": "revise",
            "findings": [
                {"severity": "major", "dimension": "architecture", "topic": "Missing rollback"}
            ],
        }]
        path = write_history(self.tmpdir, history)
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["escalate"])

    def test_same_major_finding_two_iterations_escalates(self):
        self.assert_script_exists()
        finding = {
            "severity": "major",
            "dimension": "architecture",
            "topic": "Missing rollback strategy",
        }
        history = [
            {"iteration": 1, "score": 70, "verdict": "revise", "findings": [finding]},
            {"iteration": 2, "score": 71, "verdict": "revise", "findings": [finding]},
        ]
        path = write_history(self.tmpdir, history)
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["escalate"])
        self.assertEqual(len(result["stuck_findings"]), 1)
        self.assertEqual(result["stuck_findings"][0]["dimension"], "architecture")
        self.assertEqual(result["stuck_findings"][0]["topic"], "Missing rollback strategy")

    def test_same_dimension_different_topic_no_escalate(self):
        self.assert_script_exists()
        history = [
            {"iteration": 1, "score": 70, "verdict": "revise", "findings": [
                {"severity": "major", "dimension": "architecture", "topic": "A"}
            ]},
            {"iteration": 2, "score": 71, "verdict": "revise", "findings": [
                {"severity": "major", "dimension": "architecture", "topic": "B"}
            ]},
        ]
        path = write_history(self.tmpdir, history)
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["escalate"])

    def test_minor_only_not_escalated(self):
        self.assert_script_exists()
        finding = {"severity": "minor", "dimension": "style", "topic": "Wording"}
        history = [
            {"iteration": 1, "score": 85, "verdict": "revise", "findings": [finding]},
            {"iteration": 2, "score": 85, "verdict": "revise", "findings": [finding]},
        ]
        path = write_history(self.tmpdir, history)
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["escalate"])

    def test_legacy_blocking_severity_treated_as_major(self):
        self.assert_script_exists()
        finding = {"severity": "blocking", "dimension": "edge_cases", "topic": "Empty input"}
        history = [
            {"iteration": 1, "score": 65, "verdict": "fail", "findings": [finding]},
            {"iteration": 2, "score": 66, "verdict": "fail", "findings": [finding]},
        ]
        path = write_history(self.tmpdir, history)
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["escalate"])
        self.assertEqual(result["stuck_findings"][0]["topic"], "Empty input")

    def test_critical_finding_escalates(self):
        self.assert_script_exists()
        finding = {"severity": "critical", "dimension": "security", "topic": "Token leak"}
        history = [
            {"iteration": 1, "score": 40, "verdict": "block", "findings": [finding]},
            {"iteration": 2, "score": 45, "verdict": "block", "findings": [finding]},
        ]
        path = write_history(self.tmpdir, history)
        proc = run_script(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["escalate"])

    def test_corrupt_history_warns_and_returns_no_escalate(self):
        self.assert_script_exists()
        path = os.path.join(self.tmpdir, "broken.json")
        with open(path, "w") as f:
            f.write("{not valid json")
        proc = run_script(path)
        # Script should return exit 0 and escalate=false, with stderr warning
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["escalate"])

    def test_min_severity_override_minor(self):
        self.assert_script_exists()
        finding = {"severity": "minor", "dimension": "style", "topic": "Wording"}
        history = [
            {"iteration": 1, "score": 85, "verdict": "revise", "findings": [finding]},
            {"iteration": 2, "score": 85, "verdict": "revise", "findings": [finding]},
        ]
        path = write_history(self.tmpdir, history)
        proc = run_script(path, extra_args=["--min-severity", "minor"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["escalate"])


if __name__ == "__main__":
    unittest.main()
