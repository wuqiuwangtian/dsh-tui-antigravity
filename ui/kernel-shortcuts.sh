#!/bin/sh
# Optional host integration for dsh-tui 0.20.2.
set -eu
patch=$(realpath "$(dirname "$0")/kernel-shortcuts-0.20.2.patch")
cd "${DSH_HOME:-$HOME/.dsh}/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui"
node -e "const p=require('./package.json'); if(p.name !== '@deepseek-harness-tui/dsh-tui' || p.version !== '0.20.2') throw Error('Requires dsh-tui 0.20.2')"
case "${1:-install}" in
  install)
    if git apply --reverse --check "$patch" 2>/dev/null; then
      echo 'Kernel shortcuts already installed.'
    else
      git apply --whitespace=nowarn "$patch"
    fi ;;
  remove)
    if git apply --check "$patch" 2>/dev/null; then
      echo 'Kernel shortcuts already removed.'
    else
      git apply --reverse --whitespace=nowarn "$patch"
    fi ;;
  *) echo 'Usage: kernel-shortcuts.sh [install|remove]' >&2; exit 2 ;;
esac
