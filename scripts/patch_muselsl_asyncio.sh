#!/usr/bin/env bash
# @author: @franckPrts
# Reapply asyncio fix for muselsl on Python 3.10+ (pip upgrade overwrites site-packages).
# Uses one persistent event loop (Bleak requires the same loop for connect/subscribe).
# Run with the NeuroTheater conda env active: bash scripts/patch_muselsl_asyncio.sh

set -euo pipefail
export MUSEL_BACKENDS="$(python -c "import muselsl.backends, os; print(os.path.abspath(muselsl.backends.__file__))")"
python <<'PY'
import os
import pathlib
import sys

p = pathlib.Path(os.environ["MUSEL_BACKENDS"])
text = p.read_text()

if "One persistent loop for all Bleak I/O" in text and "_loop = None" in text:
    print("Already patched:", p)
    sys.exit(0)

needle = "from .constants import RETRY_SLEEP_TIMEOUT"
if needle not in text or "def sleep(seconds):" not in text:
    print("Unexpected muselsl/backends.py layout. File:", p, file=sys.stderr)
    sys.exit(1)

start = text.index(needle)
end = text.index("def sleep(seconds):")

replacement = """from .constants import RETRY_SLEEP_TIMEOUT

# One persistent loop for all Bleak I/O. asyncio.run() creates a new loop per call and
# breaks Bleak (Futures/tasks must stay on the loop that created the client).
_loop = None


def _wait(coroutine):
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
    return _loop.run_until_complete(coroutine)

"""

p.write_text(text[:start] + replacement + text[end:])
print("Patched:", p)
PY
