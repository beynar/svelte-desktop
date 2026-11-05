"""The wire between the Python process and the shell's bridge (native/sdk/python/bridge.cc).

The shell writes calls on stdin, one JSON object per line: {"id", "service", "op", "args"}.
The process answers on the original stdout (fd 1 is re-pointed at stderr, so print() and C
libraries writing to stdout never corrupt it), one line each:

    READY                      every module imported, commands registered
    R <id> <json>              resolve
    E <id> <code> <message>    reject (the message on one line)
    V <event> <json>           emit an event to pages and server code
    L <message>                a line for the app's log
"""

from __future__ import annotations

import base64
import dataclasses
import datetime
import decimal
import enum
import json
import math
import os
import pathlib
import re
import sys
import threading
import uuid
from typing import Any, TextIO

_out: TextIO | None = None
_lock = threading.Lock()
_EVENT = re.compile(r"^[A-Za-z0-9_.:/-]+$")


def open_channel() -> None:
    """Keeps the real stdout for the protocol; everything else written to stdout goes to stderr."""
    global _out
    sys.stdout.flush()
    fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    _out = os.fdopen(fd, "w", encoding="utf-8", newline="\n", buffering=1)


def send(line: str) -> None:
    with _lock:
        if _out is None:  # outside the app (tests, a plain `python file.py`)
            return
        _out.write(line + "\n")
        _out.flush()


def one_line(text: str) -> str:
    return " ".join(str(text).split()) or "error"


def encode(value: Any) -> str:
    try:
        return json.dumps(value, default=_default, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
    except ValueError:  # NaN / Infinity: not JSON — null, as JSON.stringify does
        return json.dumps(_finite(value), default=_default, allow_nan=False, ensure_ascii=False, separators=(",", ":"))


def _finite(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    plain = _default(value) if not isinstance(value, (str, int, bool, type(None))) else value
    return value if plain is value else _finite(plain)


def _default(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: getattr(value, f.name) for f in dataclasses.fields(value)}
    dump = getattr(value, "model_dump", None)  # pydantic v2
    if callable(dump):
        return dump(mode="json")
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (set, frozenset)):
        return list(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (pathlib.PurePath, uuid.UUID)):
        return str(value)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    tolist = getattr(value, "tolist", None)  # numpy arrays and scalars, torch tensors
    if callable(tolist):
        return tolist()
    item = getattr(value, "item", None)
    if callable(item):
        return item()
    if hasattr(value, "__iter__"):
        return list(value)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def emit(event: str, data: Any = None) -> None:
    """Broadcasts an event to every page and to server code (`host.on(event, fn)`). Any thread."""
    if not _EVENT.match(event):
        raise ValueError(f"kitop: event name {event!r} may only hold letters, digits and _ . : / -")
    send(f"V {event} {encode(data)}")


def log(message: str) -> None:
    """Writes a line in the app's log."""
    send(f"L {one_line(message)}")
