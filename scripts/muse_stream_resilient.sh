#!/usr/bin/env bash
# Run muselsl stream for a Muse headset, restarting after disconnect or process exit.
# Resolves --address from nickname.json by nickname, hardware_sticker, or full MAC UUID.
#
# Usage:
#   muse_stream_resilient.sh [options] DEVICE [-- extra muselsl stream flags...]
#
# Examples:
#   ./scripts/muse_stream_resilient.sh -n 10 -i 8 Berton
#   ./scripts/muse_stream_resilient.sh 22FC -- --ppg --acc --gyro
#   ./scripts/muse_stream_resilient.sh AC8CD4BB-830A-61D4-580A-C280E1366463
#
# Activates the NeuroTheater Conda env via ../run_env_neurtheater.sh (after parsing args,
# so --help does not require conda). Override the env name with NTA_CONDA_ENV.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_NICKNAME_JSON="${REPO_ROOT}/nickname.json"

MAX_RETRIES=0
INTERVAL=5
NICKNAME_JSON=""
DEVICE=""
MUSEL_EXTRA=()
PASSTHROUGH=false

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  -n, --max-retries N   Max times to launch muselsl (including the first). 0 = unlimited.
  -i, --interval SEC    Seconds to wait before the next attempt after exit/disconnect.
  -f, --nickname-json PATH   Path to nickname.json (default: repo root nickname.json)
  -h, --help            Show this help.

Conda env: sources ${REPO_ROOT}/run_env_neurtheater.sh (default env: neurotheater; set NTA_CONDA_ENV to override).

If you omit "--", default muselsl flags after stream are: --ppg --acc --gyro
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n)
      MAX_RETRIES="$2"
      shift 2
      ;;
    --max-retries)
      MAX_RETRIES="$2"
      shift 2
      ;;
    -i)
      INTERVAL="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    -f)
      NICKNAME_JSON="$2"
      shift 2
      ;;
    --nickname-json)
      NICKNAME_JSON="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      PASSTHROUGH=true
      MUSEL_EXTRA=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$DEVICE" ]]; then
        echo "Unexpected extra argument: $1" >&2
        exit 1
      fi
      DEVICE="$1"
      shift
      ;;
  esac
done

if [[ -z "$DEVICE" ]]; then
  echo "DEVICE is required (nickname, hardware_sticker, or Muse MAC UUID)." >&2
  usage >&2
  exit 1
fi

_env_helper="${REPO_ROOT}/run_env_neurtheater.sh"
if [[ ! -f "$_env_helper" ]]; then
  echo "muse_stream_resilient: missing ${_env_helper}" >&2
  exit 1
fi
# shellcheck source=/dev/null
if ! source "$_env_helper"; then
  echo "muse_stream_resilient: failed to activate Conda env (NTA_CONDA_ENV=${NTA_CONDA_ENV:-neurotheater})." >&2
  exit 1
fi
unset _env_helper

if [[ -z "$NICKNAME_JSON" ]]; then
  NICKNAME_JSON="$DEFAULT_NICKNAME_JSON"
fi

if [[ ! -f "$NICKNAME_JSON" ]]; then
  echo "nickname.json not found: $NICKNAME_JSON" >&2
  exit 1
fi

if ! $PASSTHROUGH; then
  MUSEL_EXTRA=(--ppg --acc --gyro)
fi

resolve_mac() {
  python3 - "$NICKNAME_JSON" "$DEVICE" <<'PY'
import json
import re
import sys

path, key = sys.argv[1], sys.argv[2].strip()
uuid_re = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"
)
if uuid_re.match(key):
    print(key)
    sys.exit(0)

try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except (OSError, json.JSONDecodeError, UnicodeError) as e:
    print(f"Failed to read {path}: {e}", file=sys.stderr)
    sys.exit(1)

headsets = data.get("headsets") or []
if not isinstance(headsets, list):
    print("nickname.json: 'headsets' must be a list", file=sys.stderr)
    sys.exit(1)

kl = key.lower()
by_nick: list[str] = []
by_hw: list[str] = []

for row in headsets:
    if not isinstance(row, dict):
        continue
    mac = str(row.get("mac") or "").strip()
    if not mac:
        continue
    nick = str(row.get("nickname") or "").strip()
    hw = str(row.get("hardware_sticker") or "").strip()
    if nick and nick.lower() == kl:
        by_nick.append(mac)
    elif hw and hw.lower() == kl:
        by_hw.append(mac)

matches = by_nick if by_nick else by_hw

if len(matches) == 0:
    print(
        f"No headset in {path!r} matches {key!r} (nickname or hardware_sticker).",
        file=sys.stderr,
    )
    sys.exit(1)
if len(matches) > 1:
    print(
        f"Ambiguous match for {key!r}: multiple entries share that nickname or sticker.",
        file=sys.stderr,
    )
    sys.exit(1)

print(matches[0])
PY
}

MAC="$(resolve_mac)" || exit 1

RUNNER_EXIT_DISCONNECT=2

run_muselsl_session() {
  python3 - "$MAC" "$RUNNER_EXIT_DISCONNECT" "${MUSEL_EXTRA[@]}" <<'PY'
import re
import signal
import subprocess
import sys
import threading
import time

mac = sys.argv[1]
code_disconnect = int(sys.argv[2])
extra = sys.argv[3:]
args = ["muselsl", "stream", "--address", mac, *extra]
pat = re.compile(r"disconnected", re.I)

proc: subprocess.Popen[str] | None = None
disconnect_seen = threading.Event()

def on_signal(signum, frame):
    if proc is not None and proc.poll() is None:
        proc.terminate()
    sys.exit(128 + signum)


signal.signal(signal.SIGINT, on_signal)
signal.signal(signal.SIGTERM, on_signal)

proc = subprocess.Popen(
    args,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

def read_stdout():
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        if pat.search(line):
            disconnect_seen.set()
            proc.terminate()
            break


reader = threading.Thread(target=read_stdout, daemon=True)
reader.start()

code = proc.wait()
reader.join(timeout=3)

if disconnect_seen.is_set():
    if code is None or code == 0:
        time.sleep(0.2)
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=5)
    sys.exit(code_disconnect)

sys.exit(code if code is not None else 1)
PY
}

SESSION_PID=""
cleanup() {
  local sig="${1:-}"
  if [[ -n "$SESSION_PID" ]] && kill -0 "$SESSION_PID" 2>/dev/null; then
    kill -TERM "$SESSION_PID" 2>/dev/null || true
    wait "$SESSION_PID" 2>/dev/null || true
  fi
  if [[ "$sig" == "INT" ]]; then
    exit 130
  fi
  if [[ "$sig" == "TERM" ]]; then
    exit 143
  fi
}

trap 'cleanup INT' INT
trap 'cleanup TERM' TERM

runs=0
while true; do
  if [[ "$MAX_RETRIES" -gt 0 && "$runs" -ge "$MAX_RETRIES" ]]; then
    echo "Stopped after $runs attempt(s) (max-retries=$MAX_RETRIES)." >&2
    exit 1
  fi
  runs=$((runs + 1))
  echo "[muse_stream_resilient] Attempt $runs → muselsl stream --address $MAC ${MUSEL_EXTRA[*]}" >&2

  run_muselsl_session &
  SESSION_PID=$!
  wait "$SESSION_PID" || true
  rc=$?
  SESSION_PID=""

  if [[ "$rc" -eq 130 || "$rc" -eq 143 ]]; then
    exit "$rc"
  fi

  if [[ "$MAX_RETRIES" -gt 0 && "$runs" -ge "$MAX_RETRIES" ]]; then
    echo "[muse_stream_resilient] muselsl exited with code $rc; max attempts reached." >&2
    exit "$rc"
  fi

  echo "[muse_stream_resilient] Session ended (exit $rc). Retrying in ${INTERVAL}s..." >&2
  sleep "$INTERVAL"
done
