#!/usr/bin/env bash
# Run from a checked-out release tag. Local first publish uses npm web authentication.
set -euo pipefail
version=$(node -p "require('./package.json').version")
tag="v$version"
test "$(node -p "require('./dsh-plugin.json').version")" = "$version"
test "$(git rev-parse HEAD)" = "$(git rev-list -n1 "$tag")"
test -z "$(git status --porcelain)"
dist=$(mktemp -d)
trap 'rm -rf "$dist"' EXIT
archive=$(npm pack --silent --pack-destination "$dist")
(cd "$dist" && sha256sum "$archive" >SHA256SUMS)
name=$(node -p "require('./package.json').name")
url="https://registry.npmjs.org/$name/$version"
status=$(curl -sS --retry 3 -o "$dist/metadata.json" -w '%{http_code}' "$url")
case "$status" in
  404) npm publish "$dist/$archive" --access public --registry=https://registry.npmjs.org ;;
  200) echo "Checking previously published $name@$version" ;;
  *) echo "Registry returned HTTP $status" >&2; exit 1 ;;
esac
# Compare downloaded bytes even on retries before attaching anything to a release.
curl -fsS --retry 5 --retry-all-errors "$url" -o "$dist/metadata.json"
asset_url=$(node -p "require(process.argv[1]).dist.tarball" "$dist/metadata.json")
curl -fsSL --retry 3 "$asset_url" -o "$dist/from-registry.tgz"
cmp "$dist/$archive" "$dist/from-registry.tgz"
if gh release view "$tag" >/dev/null 2>&1; then
  mkdir "$dist/published"
  gh release download "$tag" -D "$dist/published"
  cmp "$dist/$archive" "$dist/published/$archive"
  cmp "$dist/SHA256SUMS" "$dist/published/SHA256SUMS"
else
  gh release create "$tag" --verify-tag --title "$tag · Antigravity for dsh-tui" --generate-notes "$dist/$archive" "$dist/SHA256SUMS"
fi
