from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

_NAME = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


@dataclass
class Command:
    service: str
    op: str
    fn: Callable[..., Any]
    module: str

    @property
    def name(self) -> str:
        return f"{self.service}.{self.op}"

    @property
    def is_async(self) -> bool:
        return inspect.iscoroutinefunction(self.fn)


commands: dict[str, Command] = {}


def command(name: str) -> Callable[[F], F]:
    """Registers the function as the command `service.op`."""
    if not _NAME.match(name):
        raise ValueError(f"kitop: command {name!r} must be named service.op (letters, digits, _ and -)")

    def register(fn: F) -> F:
        if name in commands and commands[name].fn is not fn:
            other = commands[name]
            raise ValueError(f"kitop: command {name!r} is defined twice ({other.module} and {fn.__module__})")
        service, op = name.split(".", 1)
        commands[name] = Command(service, op, fn, fn.__module__)
        return fn

    return register
