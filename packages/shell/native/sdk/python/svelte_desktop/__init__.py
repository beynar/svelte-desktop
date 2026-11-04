"""Python commands for svelte-desktop apps.

    # native/python/text.py
    from dataclasses import dataclass
    from svelte_desktop import command, emit

    @dataclass
    class Stats:
        words: int
        chars: int

    @command("text.stats")
    def stats(text: str, lowercase: bool = False) -> Stats:
        return Stats(words=len(text.split()), chars=len(text))

Each command is a platform op, like the Rust, Go and Swift ones: pages and server code call
`host.native.text.stats({ text })`, typed from the annotations (the build writes them into
src/native.d.ts). The app runs these modules in one Python process of its own, started with the
app: a crash there rejects the pending calls and the next call starts a fresh process.

Handlers run concurrently: `def` handlers on a thread pool, `async def` handlers on one asyncio
loop. Their keyword arguments come from the call's argument object.
"""

from __future__ import annotations

from ._registry import Command, command, commands
from ._protocol import emit, log

__all__ = [
    "Command",
    "Denied",
    "Error",
    "InvalidArgs",
    "Unavailable",
    "Unsupported",
    "command",
    "commands",
    "emit",
    "log",
]


class Error(Exception):
    """Rejects the call with a code: invalid_args, unsupported, unavailable, denied or internal.
    Any other exception rejects with internal."""

    code = "internal"

    def __init__(self, message: str = "", code: str | None = None):
        super().__init__(message)
        if code is not None:
            self.code = code


class InvalidArgs(Error):
    code = "invalid_args"


class Unsupported(Error):
    code = "unsupported"


class Unavailable(Error):
    code = "unavailable"


class Denied(Error):
    code = "denied"
