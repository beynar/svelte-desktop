"""python -m svelte_desktop run <dir>        serve the shell's calls (the app starts this)
python -m svelte_desktop describe <dir>   print the commands and their TypeScript types (the build)"""

import json
import sys


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("run", "describe"):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "run":
        from ._runtime import run

        run(sys.argv[2])
    else:
        from ._types import describe

        sys.stdout.write(json.dumps(describe(sys.argv[2])))


main()
