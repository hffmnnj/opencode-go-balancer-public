#!/usr/bin/env python3
"""Interactively stage two Go API keys plus the gateway local token.

Reads both keys via hidden prompts (never argv/env), validates shape, and
writes ``keys.json`` atomically with owner-only permissions. Creates the
random ``local-token`` file once and preserves an existing valid token.

Only the standard library is used. No network access, no provider
configuration, no service management. Secrets are never printed.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import stat
import sys
import tempfile
import warnings

DEFAULT_DIRECTORY = os.path.join(
    os.path.expanduser("~"), ".config", "opencode-v2", "opencode-go-balancer"
)
KEYS_FILENAME = "keys.json"
TOKEN_FILENAME = "local-token"
KEY_LABELS = ("go-1", "go-2")
MAX_KEY_LENGTH = 4096
TOKEN_BYTES = 32
TOKEN_HEX_LENGTH = TOKEN_BYTES * 2
DIR_MODE = 0o700
FILE_MODE = 0o600


def validate_key(value):
    """Return ``value`` if it is an acceptable API key, else raise ValueError.

    The error message is generic on purpose: it never echoes the input.
    """
    if not isinstance(value, str):
        raise ValueError("key is invalid: must be text")
    if not value or len(value) > MAX_KEY_LENGTH:
        raise ValueError("key is invalid: must be 1..4096 characters")
    for char in value:
        code = ord(char)
        if code < 0x21 or code > 0x7E:
            raise ValueError(
                "key is invalid: ASCII printable non-whitespace only, no CR/LF"
            )
    return value


def validate_key_pair(first, second):
    """Validate two keys and require them to be distinct."""
    validate_key(first)
    validate_key(second)
    if first == second:
        raise ValueError("keys are invalid: the two keys must differ")
    return (first, second)


def build_keys_document(first, second):
    """Build the keys.json payload; validates before building."""
    validate_key_pair(first, second)
    return {
        "keys": [
            {"label": KEY_LABELS[0], "key": first},
            {"label": KEY_LABELS[1], "key": second},
        ]
    }


def _reject_symlink(path, what):
    if os.path.islink(path):
        raise ValueError("%s must not be a symlink: %s" % (what, path))


def ensure_directory(path):
    """Ensure the staging directory exists, owned by us, mode 0700.

    Refuses symlinks and wrong owners. Returns the absolute path.
    """
    expanded = os.path.abspath(os.path.expanduser(path))
    _reject_symlink(expanded, "config directory")
    if os.path.lexists(expanded) and not os.path.isdir(expanded):
        raise ValueError("config path exists and is not a directory")
    if not os.path.isdir(expanded):
        os.makedirs(expanded, mode=DIR_MODE, exist_ok=True)
    st = os.stat(expanded)
    if st.st_uid != os.geteuid():
        raise ValueError("config directory is not owned by the current user")
    if not stat.S_ISDIR(st.st_mode):
        raise ValueError("config path is not a directory")
    os.chmod(expanded, DIR_MODE)
    return expanded


def _check_existing_file_safe(path, what):
    """Return True if a safe regular file exists, False if absent.

    Raises ValueError for symlinks, wrong owners, unsafe modes, or
    non-regular files. Never overwrites anything.
    """
    if not os.path.lexists(path):
        return False
    _reject_symlink(path, what)
    st = os.stat(path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("%s exists and is not a regular file" % what)
    if st.st_uid != os.geteuid():
        raise ValueError("%s is not owned by the current user" % what)
    if st.st_mode & 0o777 & 0o077:
        raise ValueError(
            "%s is group/other-accessible; fix or remove it manually" % what
        )
    return True


def is_valid_token(text):
    """Check whether text is a valid stored local token (64 hex chars)."""
    if not isinstance(text, str):
        return False
    cleaned = text.strip()
    if len(cleaned) != TOKEN_HEX_LENGTH:
        return False
    return all(c in "0123456789abcdefABCDEF" for c in cleaned)


def write_file_atomic(directory, filename, data):
    """Atomically write owner-only ``filename`` in ``directory``.

    Uses a same-directory mode-0600 tempfile plus os.replace, fsyncs the
    file before the rename and the directory after. Cleans up only the
    temp file it created, never anything else.
    """
    target = os.path.join(directory, filename)
    _reject_symlink(target, filename)
    fd, tmp_path = tempfile.mkstemp(prefix=filename + ".", suffix=".tmp", dir=directory)
    try:
        os.chmod(tmp_path, FILE_MODE)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, FILE_MODE)
        os.replace(tmp_path, target)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    try:
        dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return target
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return target


def write_keys_file(directory, first, second):
    """Validate and atomically write keys.json; returns its path."""
    if _check_existing_file_safe(os.path.join(directory, KEYS_FILENAME), KEYS_FILENAME):
        # Existing file already vetted: still replaced atomically below so
        # the result always has safe ownership and mode 0600.
        pass
    document = build_keys_document(first, second)
    payload = (json.dumps(document, indent=2) + "\n").encode("utf-8")
    return write_file_atomic(directory, KEYS_FILENAME, payload)


def ensure_local_token(directory):
    """Create local-token once (32 random bytes, hex); preserve valid ones.

    Returns (path, created). Raises ValueError for unsafe or malformed
    existing files instead of silently rotating them.
    """
    path = os.path.join(directory, TOKEN_FILENAME)
    if _check_existing_file_safe(path, TOKEN_FILENAME):
        with open(path, "r", encoding="ascii") as handle:
            current = handle.read()
        if is_valid_token(current):
            return (path, False)
        raise ValueError(
            "local-token exists but is malformed; remove it manually to regenerate"
        )
    token = secrets.token_hex(TOKEN_BYTES)
    write_file_atomic(directory, TOKEN_FILENAME, (token + "\n").encode("ascii"))
    return (path, True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Stage two Go API keys and the gateway local token."
    )
    parser.add_argument(
        "--directory",
        default=DEFAULT_DIRECTORY,
        help="staging directory (default: %(default)s)",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not sys.stdin.isatty():
        print("error: run this command in a terminal for hidden key entry", file=sys.stderr)
        return 1
    try:
        directory = ensure_directory(args.directory)
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            first = getpass.getpass("Go API key 1: ")
            second = getpass.getpass("Go API key 2: ")
        validate_key_pair(first, second)
        ensure_local_token(directory)
        keys_path = write_keys_file(directory, first, second)
    except getpass.GetPassWarning:
        print("error: terminal cannot hide key input", file=sys.stderr)
        return 1
    except ValueError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    except (OSError, EOFError, KeyboardInterrupt) as exc:
        print("error: %s" % type(exc).__name__, file=sys.stderr)
        return 1
    # Success: print only the staged keys path (never keys or tokens).
    print(keys_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
