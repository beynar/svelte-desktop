# The Modules page's forecast: a linear trend with numpy, in the app's own Python process.
# host.native.forecast.trend({ values, horizon }) — typed from these annotations (src/native.d.ts).
import os
import platform
from dataclasses import dataclass

import numpy as np
from svelte_desktop import InvalidArgs, command


@dataclass
class Forecast:
    slope: float
    fitted: list[float]
    forecast: list[float]
    low: list[float]
    high: list[float]
    r2: float


@dataclass
class Runtime:
    pid: int
    python: str
    numpy: str


@command("forecast.trend")
def trend(values: list[float], horizon: int = 7) -> Forecast:
    if len(values) < 3:
        raise InvalidArgs("at least 3 values")
    if not 1 <= horizon <= 90:
        raise InvalidArgs("horizon is 1 to 90 days")
    y = np.asarray(values, dtype=float)
    x = np.arange(len(y))
    slope, intercept = np.polyfit(x, y, 1)
    fitted = slope * x + intercept
    residual = y - fitted
    spread = 1.96 * residual.std()  # ~95% of the days fall in the band
    ahead = slope * np.arange(len(y), len(y) + horizon) + intercept
    total = ((y - y.mean()) ** 2).sum()
    return Forecast(
        slope=slope,
        fitted=fitted,
        forecast=ahead,
        low=np.maximum(ahead - spread, 0),
        high=ahead + spread,
        r2=1 - (residual**2).sum() / total if total else 1.0,
    )


@command("forecast.runtime")
def runtime() -> Runtime:
    return Runtime(pid=os.getpid(), python=platform.python_version(), numpy=np.__version__)


# Ends the process on purpose: the call rejects, the app keeps running, the next call starts a
# new process.
@command("forecast.crash")
def crash() -> None:
    os._exit(1)
