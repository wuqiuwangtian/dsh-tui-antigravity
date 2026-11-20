#!/usr/bin/env bash
# Requires an isolated DSH_HOME and a clean working directory for each run.
set -euo pipefail
: "${DSH_HOME:?set an isolated test profile}"
: "${HOST_VERSION:?set the candidate dsh-tui version}"
repo=$(cd "$(dirname "$0")/.." && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
cd "$sandbox"
dsh plugin --profile dsh-tui add "@deepseek-harness-tui/dsh-tui@$HOST_VERSION"
# The default checks the actual published plugin, including registry installation.
dsh plugin --profile dsh-tui add "${PLUGIN_SPEC:-dsh-tui-antigravity}"
modules="$DSH_HOME/profiles/dsh-tui/node_modules"
plugin="$modules/dsh-tui-antigravity"
host="$modules/@deepseek-harness-tui/dsh-tui"
mkdir -p "$sandbox/bin"
ln -s "$host/bin/dsh-tui.js" "$sandbox/bin/dsh-tui"
export PATH="$sandbox/bin:$PATH"
case "$1" in
  backend)
    python "$repo/test/tui_smoke.py" --accounts
    mkdir test
    cp "$repo/test/"{session.test.js,agent.mjs} test/
    ln -s "$plugin/backend.js" backend.js
    echo '{"type":"module"}' >package.json
    node --test test/session.test.js
    ;;
  ui)
    cd "$host"
    files=(lib/types/branding.js lib/types/components/{LogoV2,maidPortrait,splashFonts}.js)
    sha256sum "${files[@]}" >"$sandbox/before"
    patches=("$plugin/ui/dsh-tui-0.20.2.patch" "$plugin/ui/portrait-pixels.patch")
    # Probe candidate host files only. Production keeps its explicit version gate.
    for patch in "${patches[@]}"; do git apply "$patch"; done
    python "$repo/test/brand_pty.py" "$repo/test/agent.mjs"
    git apply --reverse "${patches[1]}"
    git apply --reverse "${patches[0]}"
    sha256sum -c "$sandbox/before"
    test ! -e assets/antigravity/cat.png
    test ! -e lib/types/components/AntigravityArt.js
    ;;
  *) exit 2 ;;
esac
