#!/usr/bin/env bash
# Renders every raster copy of the logo from brand/logo.svg.
# Needs librsvg's rsvg-convert (`brew install librsvg`, `apt install librsvg2-bin`).
# Run from anywhere: brand/build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
pkgs="$root/app/packages"
src="$here/logo.svg"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v rsvg-convert >/dev/null || {
  echo "rsvg-convert not found (brew install librsvg)" >&2
  exit 1
}

# Derived sources. Every element of the tile carries an id starting `iw-tile`,
# so the variants are line edits of the one file rather than copies of it.
#   square: the tile without its rounded corners (iOS masks its own).
#   mark:   the white wrench alone on transparency (Android adaptive foreground).
#   background: the tile alone, full bleed (Android adaptive background).
sed 's/ rx="114"//' "$src" >"$tmp/square.svg"
grep -v 'id="iw-tile' "$src" >"$here/mark.svg"
sed -e 's/ rx="114"//' -e '/<g transform/,/^  <\/g>/d' "$src" >"$tmp/background.svg"

# Places an SVG's contents at a size and offset on a square canvas. Nested
# inline rather than through <image>, which rsvg-convert refuses to load from
# outside the wrapper's own directory.
inset() { # canvas offset size source
  {
    echo "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"$1\" height=\"$1\">"
    echo "<svg x=\"$2\" y=\"$2\" width=\"$3\" height=\"$3\" viewBox=\"0 0 512 512\">"
    sed -e '1d' "$4"
    echo "</svg>"
  }
}
# macOS: the 824px tile on a 1024px canvas, per Apple's app icon grid.
inset 1024 100 824 "$src" >"$tmp/macos.svg"

render() { rsvg-convert -w "$1" -h "$1" "$2" -o "$3"; }

# VS Code's activity bar uses its icon as a mask: the wrench alone, in currentColor.
sed -e 's/mask="url(#iw-wrench-cut)" fill="#fff"/mask="url(#iw-wrench-cut)" fill="currentColor"/' -e '/<title>/d' "$here/mark.svg" | grep -v 'stop\|Gradient' >"$pkgs/vscode/media/activity.svg"

# Vector copies served as-is.
cp "$src" "$pkgs/web/public/favicon.svg"
cp "$src" "$pkgs/website/public/icon.svg"
cp "$src" "$pkgs/instances/public/icon.svg"

render 1024 "$tmp/macos.svg" "$pkgs/desktop/build/icon.png"
render 512 "$src" "$pkgs/web/public/favicon.png"
render 512 "$src" "$pkgs/website/public/icon.png"
render 256 "$src" "$pkgs/instances/public/icon.png"
render 80 "$src" "$pkgs/instances/lib/og-logo.png"
render 512 "$src" "$pkgs/raycast/assets/icon.png"
render 128 "$src" "$pkgs/vscode/media/icon.png"
render 1024 "$tmp/square.svg" "$pkgs/mobile/assets/icon.png"
render 1024 "$tmp/background.svg" "$pkgs/mobile/assets/adaptive-icon-background.png"

# The adaptive foreground keeps the wrench inside the 66dp safe circle of the
# 108dp layer: render it at 60% and centre it on a transparent canvas.
inset 1024 205 614 "$here/mark.svg" >"$tmp/adaptive.svg"
render 1024 "$tmp/adaptive.svg" "$pkgs/mobile/assets/adaptive-icon.png"

echo "Rendered logo assets from $src"
