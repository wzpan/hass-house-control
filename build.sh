#!/bin/bash
# Rebuilds the two files Home Assistant needs:
#   house-control-card.js  - the Lovelace card (copied from src/)
#   embed.html             - the upstream web app, inlined into one self-contained page
#
# Usage:
#   HC=/path/to/house-control ./build.sh      # defaults to ../house-control
#
# HC must point at a checkout of https://github.com/0xProbabillity/house-control
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HC="${HC:-$(cd "$HERE/.." && pwd)/house-control}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ ! -d "$HC/web" ]; then
  echo "House Control checkout not found at $HC (set HC=/path/to/house-control)" >&2
  exit 1
fi

(cd "$HC/web" && npm run build --silent >/dev/null)

rm -rf "$HERE/.build"
cp -R "$HC/web/dist" "$HERE/.build"
cp "$HERE/src/house-control-card.js" "$HERE/.build/"

# embed.html: one self-contained page (shim, app bundle and styles inline). The card runs it
# in a sandboxed iframe with an opaque origin, where fetching ./assets/* would need CORS.
"$NODE_BIN" -e '
const fs = require("fs"), path = require("path");
const [build, src] = process.argv.slice(1);
let html = fs.readFileSync(path.join(build, "index.html"), "utf8");
const read = (rel) => fs.readFileSync(path.join(build, rel), "utf8");
const safe = (js) => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const shim = fs.readFileSync(path.join(src, "ha-embed.js"), "utf8");
const embedCss = fs.readFileSync(path.join(src, "embed.css"), "utf8");
html = html.replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/, (_, rel) =>
  `<script>${safe(shim)}</script>\n    <script type="module">${safe(read(rel))}</script>`);
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/, (_, rel) =>
  `<style>${read(rel)}</style>\n    <style>${embedCss}</style>`);
if (/src="\.\/assets|href="\.\/assets/.test(html)) throw new Error("embed.html still references ./assets");
fs.writeFileSync(path.join(build, "embed.html"), html);
console.log("embed.html", (html.length / 1024).toFixed(0), "KB");
' "$HERE/.build" "$HERE/src"

mv "$HERE/.build/embed.html" "$HERE/embed.html"
mv "$HERE/.build/house-control-card.js" "$HERE/house-control-card.js"
rm -rf "$HERE/.build"
echo "built: $HERE/house-control-card.js $HERE/embed.html"
