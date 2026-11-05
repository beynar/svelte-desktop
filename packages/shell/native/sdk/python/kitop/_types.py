"""`python -m kitop describe <dir>`: the commands and their TypeScript types, in the shape
the other SDKs' `sd_plugin_describe` returns ({language, commands: [{service, op, args, result}]})."""

from __future__ import annotations

import collections.abc
import dataclasses
import datetime
import decimal
import enum
import inspect
import json
import pathlib
import types
import typing
import uuid
from typing import Any

from ._registry import Command, commands

_PRIMITIVES: dict[Any, str] = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    bytes: "string",  # base64
    bytearray: "string",
    decimal.Decimal: "number",
    datetime.datetime: "string",
    datetime.date: "string",
    datetime.time: "string",
    uuid.UUID: "string",
    type(None): "null",
    None: "null",
    Any: "unknown",
    object: "unknown",
}
_SEQUENCES = (list, set, frozenset, collections.abc.Sequence, collections.abc.Set, collections.abc.Iterable, collections.abc.Collection, collections.abc.Iterator, collections.abc.Generator)
_MAPPINGS = (dict, collections.abc.Mapping, collections.abc.MutableMapping)


def _key(name: str) -> str:
    return name if name.isidentifier() else json.dumps(name)


def _obj(fields: list[tuple[str, str, bool]]) -> str:
    if not fields:
        return "Record<string, never>"
    return "{ " + "; ".join(f"{_key(n)}{'' if required else '?'}: {t}" for n, t, required in fields) + " }"


def ts(hint: Any, *, input: bool = False, seen: frozenset[int] = frozenset()) -> str:
    """The TypeScript type of a Python annotation. `input`: fields with defaults are optional."""
    if hint is inspect.Parameter.empty:
        return "unknown"
    if hint in _PRIMITIVES:
        return _PRIMITIVES[hint]
    if isinstance(hint, type) and issubclass(hint, pathlib.PurePath):
        return "string"
    if isinstance(hint, typing.TypeVar):
        return "unknown"
    if id(hint) in seen:  # a recursive type
        return "unknown"
    seen = seen | {id(hint)}
    origin = typing.get_origin(hint)
    args = typing.get_args(hint)

    if origin is typing.Annotated:
        return ts(args[0], input=input, seen=seen)
    if origin is typing.Literal:
        return " | ".join(json.dumps(a.value if isinstance(a, enum.Enum) else a) for a in args)
    if origin is typing.Union or (hasattr(types, "UnionType") and origin is types.UnionType):
        parts = list(dict.fromkeys(ts(a, input=input, seen=seen) for a in args))
        return " | ".join(parts)
    if origin is tuple:
        if len(args) == 2 and args[1] is Ellipsis:
            return _array(ts(args[0], input=input, seen=seen))
        return "[" + ", ".join(ts(a, input=input, seen=seen) for a in args) + "]"
    if origin in _SEQUENCES:
        return _array(ts(args[0], input=input, seen=seen) if args else "unknown")
    if origin in _MAPPINGS:
        return f"Record<string, {ts(args[1], input=input, seen=seen) if len(args) == 2 else 'unknown'}>"
    if origin is not None:  # another generic (a class[...]): its origin
        return ts(origin, input=input, seen=seen)

    if hint in (list, set, frozenset, tuple):
        return "unknown[]"
    if hint is dict:
        return "Record<string, unknown>"
    if isinstance(hint, type) and issubclass(hint, enum.Enum):
        return " | ".join(json.dumps(m.value) for m in hint) or "never"
    if _is_typeddict(hint):
        hints = typing.get_type_hints(hint, include_extras=True)
        return _obj([(n, ts(_strip_required(t), input=input, seen=seen), _required(hint, t)) for n, t in hints.items()])
    if dataclasses.is_dataclass(hint) and isinstance(hint, type):
        hints = typing.get_type_hints(hint, include_extras=True)
        fields = []
        for f in dataclasses.fields(hint):
            has_default = f.default is not dataclasses.MISSING or f.default_factory is not dataclasses.MISSING
            fields.append((f.name, ts(hints.get(f.name, Any), input=input, seen=seen), not (input and has_default)))
        return _obj(fields)
    model_fields = getattr(hint, "model_fields", None)  # pydantic v2
    if isinstance(hint, type) and isinstance(model_fields, dict):
        return _obj([(n, ts(f.annotation, input=input, seen=seen), not input or f.is_required()) for n, f in model_fields.items()])
    if isinstance(hint, type) and issubclass(hint, tuple) and hasattr(hint, "_fields"):  # NamedTuple: an array
        hints = typing.get_type_hints(hint)
        return "[" + ", ".join(ts(hints.get(n, Any), input=input, seen=seen) for n in hint._fields) + "]"
    if isinstance(hint, type) and hint.__module__ == "numpy" and hint.__name__ == "ndarray":
        return "unknown[]"
    return "unknown"


def _array(item: str) -> str:
    return f"({item})[]" if " | " in item or " & " in item else f"{item}[]"


def _is_typeddict(hint: Any) -> bool:
    return isinstance(hint, type) and issubclass(hint, dict) and hasattr(hint, "__total__")


def _required(td: Any, hint: Any) -> bool:
    """Read from the annotation itself: `__required_keys__` is wrong with string annotations."""
    name = getattr(typing.get_origin(hint), "_name", None)
    if name == "ReadOnly":
        return _required(td, typing.get_args(hint)[0])
    return True if name == "Required" else False if name == "NotRequired" else bool(getattr(td, "__total__", True))


def _strip_required(hint: Any) -> Any:
    origin = typing.get_origin(hint)
    if origin is not None and getattr(origin, "_name", None) in ("Required", "NotRequired", "ReadOnly"):
        return _strip_required(typing.get_args(hint)[0])
    return hint


def describe_command(cmd: Command) -> dict[str, Any]:
    sig = inspect.signature(cmd.fn)
    try:
        hints = typing.get_type_hints(cmd.fn, include_extras=True)
    except Exception:
        hints = {}
    fields: list[tuple[str, str, bool]] = []
    open_ended = False
    for name, p in sig.parameters.items():
        if p.kind is inspect.Parameter.VAR_KEYWORD:
            open_ended = True
            continue
        if p.kind is inspect.Parameter.VAR_POSITIONAL:
            continue
        fields.append((name, ts(hints.get(name, inspect.Parameter.empty), input=True), p.default is inspect.Parameter.empty))
    if not fields:
        args = "Record<string, unknown>" if open_ended else None
    else:
        args = _obj(fields) + (" & Record<string, unknown>" if open_ended else "")
    result = ts(hints.get("return", inspect.Parameter.empty))
    return {"service": cmd.service, "op": cmd.op, "args": args, "result": result}


def describe(root: str) -> dict[str, Any]:
    from ._runtime import load_modules

    load_modules(root)
    return {"language": "python", "commands": [describe_command(c) for c in sorted(commands.values(), key=lambda c: c.name)]}
