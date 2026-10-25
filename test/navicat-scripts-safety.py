"""Fixtures only: never import winreg or read the actual credential store."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import unittest

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "import-navicat-passwords.py"))
MARKER = "synthetic-private-fixture"


class Key:
    def __init__(self, kind):
        self.kind = kind

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Registry:
    HKEY_CURRENT_USER = object()

    def OpenKey(self, _root, name):
        return Key("root" if name.endswith("Servers") else "profile")

    def QueryInfoKey(self, key):
        return (1, 0, 0) if key.kind == "root" else (0, 6, 0)

    def EnumKey(self, _key, _index):
        return MARKER

    def EnumValue(self, _key, index):
        return ("Pwd", "Pwd_2", "SSH_Password", "SSH_Password_2", "Host", "UserName")[index], MARKER, 1


class Safety(unittest.TestCase):
    def invoke(self, registry, args=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = MODULE["main"]([] if args is None else args, registry)
        self.assertNotIn(MARKER, out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_only_aggregate_counts_are_output(self):
        code, output, error = self.invoke(Registry())
        self.assertEqual(code, 0)
        self.assertEqual(error, "")
        self.assertEqual(json.loads(output), {"connections": 1, "with_database_credential": 1, "with_ssh_credential": 1})
        self.assertNotIn("get_crypto", MODULE)
        self.assertNotIn("decrypt", MODULE)

    def test_registry_error_does_not_include_exception_or_profile(self):
        class Broken(Registry):
            def EnumValue(self, *_args):
                raise RuntimeError(MARKER)
        code, output, error = self.invoke(Broken())
        self.assertEqual(code, 1)
        self.assertEqual(output, "")
        self.assertIn("unavailable", error)

    def test_missing_registry_returns_zero(self):
        class Missing(Registry):
            def OpenKey(self, *_args):
                raise FileNotFoundError(MARKER)
        code, output, _error = self.invoke(Missing())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)["connections"], 0)

    def test_arguments_cannot_enable_plaintext_or_echo_secret(self):
        class NeverRead(Registry):
            def OpenKey(self, *_args):
                raise AssertionError("Registry must not be read")
        for option in ("--secrets", "--output", "--help"):
            code, output, error = self.invoke(NeverRead(), [option, MARKER])
            self.assertEqual(code, 2)
            self.assertEqual(output, "")
            self.assertIn("No export options", error)


if __name__ == "__main__":
    unittest.main()
