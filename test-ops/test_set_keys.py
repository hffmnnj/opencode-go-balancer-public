"""Ops tests for scripts/set-keys.py. Stdlib unittest only.

Covers the pure validation/build helpers plus atomic staging writes.
Interactive prompting is intentionally untested. All scratch files live in a
private directory under the system temp directory, and each test removes only
the files it created (no recursive deletion).
"""

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "scripts", "set-keys.py")
SCRATCH_BASE = tempfile.gettempdir()


def load_helper():
    spec = importlib.util.spec_from_file_location("set_keys_helper", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load_helper()

SECRET_A = "sk-go-test-key-AAA-0123456789abcdef"
SECRET_B = "sk-go-test-key-BBB-fedcba9876543210"


class SetKeysTest(unittest.TestCase):
    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="set-keys-test-", dir=SCRATCH_BASE)
        os.chmod(self.workdir, 0o700)
        self._files = []

    def tearDown(self):
        for name in self._files:
            try:
                os.unlink(os.path.join(self.workdir, name))
            except OSError:
                pass
        # Remove stray temp files this test created (atomic-write leftovers).
        try:
            leftovers = os.listdir(self.workdir)
        except OSError:
            leftovers = []
        for name in leftovers:
            if name.startswith(("keys.json.", "local-token.")):
                try:
                    os.unlink(os.path.join(self.workdir, name))
                except OSError:
                    pass
        # Remove keys.json / local-token if the helper wrote them.
        for name in ("keys.json", "local-token"):
            try:
                os.unlink(os.path.join(self.workdir, name))
            except OSError:
                pass
        try:
            os.rmdir(self.workdir)
        except OSError:
            pass

    def test_validate_key_accepts_typical_key(self):
        self.assertEqual(helper.validate_key(SECRET_A), SECRET_A)

    def test_validate_key_rejects_bad_shapes_without_echo(self):
        bad = ["", "has space", "tab\there", "nl\nx", "cr\rx",
               "non-ascii-\u00e9", "x" * 4097]
        for value in bad:
            with self.assertRaises(ValueError) as ctx:
                helper.validate_key(value)
            self.assertNotIn(value[:16] if value.strip() else "x" * 4,
                             str(ctx.exception))

    def test_validate_key_pair_rejects_duplicates(self):
        with self.assertRaises(ValueError):
            helper.validate_key_pair(SECRET_A, SECRET_A)
        self.assertEqual(helper.validate_key_pair(SECRET_A, SECRET_B),
                         (SECRET_A, SECRET_B))

    def test_build_keys_document_shape(self):
        doc = helper.build_keys_document(SECRET_A, SECRET_B)
        self.assertEqual(doc, {"keys": [
            {"label": "go-1", "key": SECRET_A},
            {"label": "go-2", "key": SECRET_B},
        ]})

    def test_write_keys_file_is_atomic_owner_only(self):
        path = helper.write_keys_file(self.workdir, SECRET_A, SECRET_B)
        self.assertEqual(path, os.path.join(self.workdir, "keys.json"))
        mode = stat.S_IMODE(os.stat(path).st_mode)
        self.assertEqual(mode, 0o600)
        with open(path, encoding="utf-8") as handle:
            doc = json.load(handle)
        self.assertEqual([e["label"] for e in doc["keys"]], ["go-1", "go-2"])
        self.assertEqual([e["key"] for e in doc["keys"]], [SECRET_A, SECRET_B])
        leftovers = [n for n in os.listdir(self.workdir) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_ensure_local_token_creates_once_and_preserves(self):
        path, created = helper.ensure_local_token(self.workdir)
        self.assertTrue(created)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with open(path, encoding="ascii") as handle:
            first = handle.read().strip()
        self.assertTrue(helper.is_valid_token(first))
        path2, created2 = helper.ensure_local_token(self.workdir)
        self.assertEqual(path2, path)
        self.assertFalse(created2)
        with open(path2, encoding="ascii") as handle:
            self.assertEqual(handle.read().strip(), first)

    def test_ensure_directory_enforces_mode_and_rejects_symlink(self):
        target = os.path.join(self.workdir, "nest")
        out = helper.ensure_directory(target)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o700)
        os.rmdir(target)
        link = os.path.join(self.workdir, "dirlink")
        os.symlink(self.workdir, link)
        self._files.append("dirlink")
        with self.assertRaises(ValueError):
            helper.ensure_directory(link)

    def test_unsafe_existing_file_is_rejected(self):
        keys_path = os.path.join(self.workdir, "keys.json")
        with open(keys_path, "w", encoding="utf-8") as handle:
            handle.write("{}\n")
        os.chmod(keys_path, 0o644)
        with self.assertRaises(ValueError):
            helper.write_keys_file(self.workdir, SECRET_A, SECRET_B)

    def test_cli_refuses_nonterminal_input_without_reading_keys(self):
        result = subprocess.run(
            [sys.executable, SCRIPT, "--directory", self.workdir],
            input=SECRET_A + "\n" + SECRET_B + "\n",
            text=True,
            capture_output=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(
            result.stderr,
            "error: run this command in a terminal for hidden key entry\n",
        )
        self.assertEqual(os.listdir(self.workdir), [])


if __name__ == "__main__":
    unittest.main()
