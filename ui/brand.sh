#!/bin/sh
# Apply the version-specific host changes as a single reversible Git patch.
set -eu
patch_file=$(realpath "$(dirname "$0")/dsh-tui-0.20.2.patch")
host="${DSH_HOME:-$HOME/.dsh}/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui"
cd "$host"
node -e "const p=require('./package.json'); if(p.name !== '@deepseek-harness-tui/dsh-tui' || p.version !== '0.20.2') throw Error('Requires dsh-tui 0.20.2')"
case "${1:-install}" in
  install) reverse=; opposite=--reverse; state=installed ;;
  remove) reverse=--reverse; opposite=; state=removed ;;
  *) echo 'Usage: brand.sh [install|remove]' >&2; exit 2 ;;
esac
if git apply $reverse --check "$patch_file" 2>/dev/null; then
  git apply $reverse "$patch_file"
elif git apply $opposite --check "$patch_file" 2>/dev/null; then
  echo "Antigravity UI already $state."
else
  echo 'Host files differ from the supported build.' >&2; exit 1
fi
