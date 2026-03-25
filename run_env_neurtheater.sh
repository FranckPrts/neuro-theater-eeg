#!/usr/bin/env bash
# NeuroTheater — cd to project root and activate Conda env "NeuroTheater"
# Usage: source ./activate_neurotheater.sh
#        (activation only persists when sourced, not when run as ./activate_neurotheater.sh)

NTA_CONDA_ENV="${NTA_CONDA_ENV:-NeuroTheater}"

if [[ -n "${ZSH_VERSION:-}" ]]; then
  case ${ZSH_EVAL_CONTEXT:-} in
    *:file) ;;
    *)
      echo "Source this file so the venv stays active in your terminal:" >&2
      echo "  source $(cd "$(dirname "$0")" && pwd)/activate_neurotheater.sh" >&2
      exit 1
      ;;
  esac
  ROOT="$(cd "$(dirname "${(%):-%x}")" && pwd)"
elif [[ -n "${BASH_VERSION:-}" ]]; then
  if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Source this file so the venv stays active in your terminal:" >&2
    echo "  source $(cd "$(dirname "$0")" && pwd)/activate_neurotheater.sh" >&2
    exit 1
  fi
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  ROOT="$(cd "$(dirname "$0")" && pwd)"
fi

cd "$ROOT" || return 1 2>/dev/null || exit 1

_nt_conda_init() {
  if command -v conda &>/dev/null; then
    if [[ -n "${ZSH_VERSION:-}" ]]; then
      eval "$(conda shell.zsh hook 2>/dev/null)"
    else
      eval "$(conda shell.bash hook 2>/dev/null)"
    fi
    return 0
  fi
  local p
  for p in \
    "$HOME/miniconda3/etc/profile.d/conda.sh" \
    "$HOME/anaconda3/etc/profile.d/conda.sh" \
    "$HOME/mambaforge/etc/profile.d/conda.sh" \
    "$HOME/miniforge3/etc/profile.d/conda.sh" \
    "/opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh" \
    "/opt/homebrew/Caskroom/miniforge/base/etc/profile.d/conda.sh" \
    "/usr/local/Caskroom/miniconda/base/etc/profile.d/conda.sh" \
    "/opt/miniconda3/etc/profile.d/conda.sh"; do
    if [[ -f "$p" ]]; then
      # shellcheck source=/dev/null
      . "$p"
      return 0
    fi
  done
  return 1
}

if ! _nt_conda_init; then
  echo "conda not found. Install Miniconda/Anaconda or add conda to PATH." >&2
  unset -f _nt_conda_init 2>/dev/null || true
  return 1 2>/dev/null || exit 1
fi
unset -f _nt_conda_init

if ! conda activate "$NTA_CONDA_ENV"; then
  echo "Failed to activate conda env '$NTA_CONDA_ENV'. Example: conda create -n $NTA_CONDA_ENV python" >&2
  return 1 2>/dev/null || exit 1
fi

echo "NeuroTheater: $(python --version 2>&1) — $(command -v python)"
