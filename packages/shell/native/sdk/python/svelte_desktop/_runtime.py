"""`python -m svelte_desktop run <dir>`: imports the app's modules, then serves the shell's calls."""

from __future__ import annotations

import asyncio
import concurrent.futures
import dataclasses
import importlib
import inspect
import json
import os
import sys
import threading
import traceback
import typing
from pathlib import Path
from typing import Any

from . import Error
from ._protocol import encode, one_line, open_channel, send
from ._registry import Command, commands

_SKIP = {"conftest", "setup", "__main__"}


def load_modules(root: str) -> list[str]:
    """Imports every top-level module of the app's Python folder (`*.py`, packages are imported
    from them). `test_*` / `*_test` files and names starting with `_` are skipped."""
    path = Path(root).resolve()
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
    names: list[str] = []
    for file in sorted(path.glob("*.py")):
        name = file.stem
        if name in _SKIP or name.startswith(("_", "test_")) or name.endswith("_test"):
            continue
        importlib.import_module(name)
        names.append(name)
    return names


def bind(cmd: Command, args: Any) -> dict[str, Any]:
    """The call's argument object as keyword arguments, models built from their dicts."""
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise Error(f"{cmd.name}: arguments must be an object", "invalid_args")
    sig = inspect.signature(cmd.fn)
    try:
        hints = typing.get_type_hints(cmd.fn)
    except Exception:
        hints = {}
    params = sig.parameters
    accepts_any = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
    unknown = [k for k in args if k not in params and not accepts_any]
    if unknown:
        raise Error(f"{cmd.name}: unknown argument{'s' if len(unknown) > 1 else ''} {', '.join(unknown)}", "invalid_args")
    out: dict[str, Any] = {}
    for name, p in params.items():
        if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if name not in args:
            if p.default is inspect.Parameter.empty:
                raise Error(f"{cmd.name}: missing argument {name}", "invalid_args")
            continue
        out[name] = _build(hints.get(name), args[name], f"{cmd.name}: {name}")
    if accepts_any:
        out.update({k: v for k, v in args.items() if k not in params})
    return out


def _build(hint: Any, value: Any, where: str) -> Any:
    """A dict passed for a dataclass / pydantic parameter becomes that class."""
    if hint is None or not isinstance(value, dict):
        return value
    try:
        if dataclasses.is_dataclass(hint) and isinstance(hint, type):
            return hint(**value)
        validate = getattr(hint, "model_validate", None)
        if callable(validate):
            return validate(value)
    except Exception as e:  # a bad field: the caller's mistake
        raise Error(f"{where}: {one_line(str(e))}", "invalid_args") from e
    return value


class Server:
    def __init__(self, workers: int):
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="command")
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="asyncio", daemon=True).start()

    def call(self, request: dict[str, Any]) -> None:
        call_id = request.get("id")
        name = f"{request.get('service')}.{request.get('op')}"
        cmd = commands.get(name)
        if cmd is None:
            send(f"E {call_id} unknown {name}: no such command")
            return
        if cmd.is_async:
            asyncio.run_coroutine_threadsafe(self._run_async(call_id, cmd, request.get("args")), self.loop)
        else:
            self.pool.submit(self._run, call_id, cmd, request.get("args"))

    def _run(self, call_id: Any, cmd: Command, args: Any) -> None:
        try:
            self._reply(call_id, cmd.fn(**bind(cmd, args)))
        except BaseException as e:  # noqa: BLE001 — every failure rejects the call
            self._fail(call_id, cmd, e)

    async def _run_async(self, call_id: Any, cmd: Command, args: Any) -> None:
        try:
            self._reply(call_id, await cmd.fn(**bind(cmd, args)))
        except BaseException as e:  # noqa: BLE001
            self._fail(call_id, cmd, e)

    def _reply(self, call_id: Any, value: Any) -> None:
        send(f"R {call_id} {encode(value)}")

    def _fail(self, call_id: Any, cmd: Command, e: BaseException) -> None:
        if isinstance(e, Error):
            send(f"E {call_id} {e.code} {one_line(str(e) or e.code)}")
            return
        # An unexpected exception: the traceback in the log, its summary to the caller.
        print(f"[python] {cmd.name} raised:\n{''.join(traceback.format_exception(e))}", file=sys.stderr, flush=True)
        send(f"E {call_id} internal {one_line(f'{type(e).__name__}: {e}')}")


def run(root: str) -> None:
    open_channel()
    load_modules(root)
    server = Server(int(os.environ.get("SVELTE_DESKTOP_PYTHON_WORKERS") or 8))
    send("READY")
    for raw in sys.stdin.buffer:  # EOF: the app is gone (or quitting)
        line = raw.decode("utf-8").strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            print(f"[python] unreadable call: {line[:200]}", file=sys.stderr, flush=True)
            continue
        server.call(request)
    # The shell closed stdin: finish nothing more, exit now (running handlers die with us).
    os._exit(0)
