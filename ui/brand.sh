#!/bin/sh
# Apply reversible patches in order, including upgrades from earlier branding patches.
set -eu
ui=$(realpath "$(dirname "$0")")
host="${DSH_HOME:-$HOME/.dsh}/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui"
cd "$host"
node -e "const p=require('./package.json'); if(p.name !== '@deepseek-harness-tui/dsh-tui' || p.version !== '0.20.2') throw Error('Requires dsh-tui 0.20.2')"
base="$ui/dsh-tui-0.20.2.patch"
portrait="$ui/portrait-pixels.patch"
title="$ui/title-proportion.patch"
case "${1:-install}" in
  install)
    if git apply --reverse --check "$title" 2>/dev/null; then
      echo 'Antigravity UI already installed.'
    elif git apply --reverse --check "$portrait" 2>/dev/null; then
      git apply "$title"
    elif git apply --reverse --check "$base" 2>/dev/null; then
      git apply "$portrait" "$title"
    else
      git apply "$base" "$portrait" "$title"
    fi ;;
  remove)
    if git apply --reverse --check "$title" 2>/dev/null; then
      git apply --reverse "$title" "$portrait" "$base"
    elif git apply --reverse --check "$portrait" 2>/dev/null; then
      git apply --reverse "$portrait" "$base"
    elif git apply --reverse --check "$base" 2>/dev/null; then
      git apply --reverse "$base"
    else
      git apply --check "$base"
      echo 'Antigravity UI already removed.'
    fi ;;
  *) echo 'Usage: brand.sh [install|remove]' >&2; exit 2 ;;
esac
