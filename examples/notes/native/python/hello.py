# Python commands: callable from pages and server code, typed from the annotations —
# host.native.hello.python({ name }) (types in src/native.d.ts, written by the build).
import asyncio
from dataclasses import dataclass

from kitop import InvalidArgs, command, emit


@dataclass
class Greeting:
    message: str


@command("hello.python")
def hello(name: str) -> Greeting:
    if not name:
        raise InvalidArgs("name is empty")
    return Greeting(message=f"Hello {name} from Python")


# Emits py.tick events (host.on('py.tick') in pages and server code), then resolves.
@command("clock.pythonCountdown")
async def countdown(start: int) -> int:
    for n in range(start, 0, -1):
        emit("py.tick", {"n": n})
        await asyncio.sleep(0.01)
    return start
