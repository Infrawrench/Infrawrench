#!/usr/bin/env bash
# builtin:vercel, builtin:cf, builtin:neon and builtin:wrangler: command-line
# programs from npm, each published as one tool of the `node` ABI that a
# job's environment runs on its own `node` (README.md, "Deployment CLIs").
#
# Each tool is a directory here: a package.json naming the program at an
# exact version, the package-lock.json that pins every package under it by
# integrity hash, and builtin.json, which says what to run and how. The
# build installs exactly the lockfile (`npm ci`, which checks every tarball
# against its hash), with no install scripts and no optional dependencies
# (the native builds per platform: a job is a WebAssembly isolate), and
# packs the resulting node_modules as a tar in a fixed order with fixed
# owners, modes and times, compressed with zstd. The tar's own SHA-256 is
# pinned in builtin.json (`tree_sha256`), so a build that installs anything
# else fails here rather than shipping; the published blob is the
# compressed tar, hashed by the store like any other.
#
#   npm-cli/build.sh                 every tool
#   npm-cli/build.sh vercel neon     just these
#   NPM_CLI_PIN=1 npm-cli/build.sh   print each tree's SHA-256 instead of
#                                    checking it (to pin a new version)
#
# Overrides in a tool's package.json replace what cannot run in a job:
# Wrangler's esbuild is esbuild-wasm (the same JavaScript API, the
# compiler as WebAssembly), and workerd, Cloudflare's local runtime, is
# stubs/workerd, which explains itself instead of throwing as it loads.
#
# To update a tool: change the version in its package.json, run
# `npm install --package-lock-only --ignore-scripts --install-links` in its
# directory, set builtin.json's version, build with NPM_CLI_PIN=1, pin the
# printed hash, and give the test in test.sh's `npm-cli` pipeline a look.
#
# Needs: node and npm 10+, GNU tar, zstd, jq.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

src="$here/npm-cli"
TOOLS=(vercel cf neon wrangler)
if [[ $# -eq 0 ]]; then
  set -- "${TOOLS[@]}"
fi

for tool in "$@"; do
  meta="$src/$tool/builtin.json"
  if [[ ! -f "$meta" ]]; then
    echo "error: no npm CLI \`$tool\`; know ${TOOLS[*]}" >&2
    exit 2
  fi
  name="$(jq -r .name "$meta")"
  version="$(jq -r .version "$meta")"
  pinned="$(jq -r .tree_sha256 "$meta")"
  if [[ "$(jq -r '.dependencies | to_entries[0].value' "$src/$tool/package.json")" != "$version" ]]; then
    echo "error: $tool: builtin.json's version is not the one package.json installs" >&2
    exit 1
  fi

  # The tool's directory beside the stubs it names (`file:../stubs/...`).
  work="$SCRATCH/$tool"
  mkdir -p "$work"
  cp -R "$src/$tool" "$work/tool"
  cp -R "$src/stubs" "$work/stubs"
  (
    cd "$work/tool"
    npm ci --omit=optional --ignore-scripts --install-links \
      --no-audit --no-fund --no-update-notifier --loglevel=error
    # What npm writes for itself, and the links to each package's commands:
    # the tool's own command is the builtin's, and nothing runs the rest.
    rm -f node_modules/.package-lock.json
    find node_modules -type d -name .bin -prune -exec rm -rf {} +
  )

  out="$(out_dir builtin "$name" "$version")"
  # A fixed order, owner, time and mode bits, so the same lockfile gives
  # the same bytes on any machine.
  (
    cd "$work/tool"
    find node_modules -print0 | LC_ALL=C sort -z |
      tar --null --no-recursion -T - --format=gnu --mtime=@0 --owner=0 --group=0 \
        --numeric-owner --mode='u+rwX,go+rX,go-w' -cf -
  ) >"$work/tree.tar"
  tree="$(sha256sum "$work/tree.tar" | cut -d' ' -f1)"
  if [[ "${NPM_CLI_PIN:-}" == 1 ]]; then
    echo "$tool: tree_sha256 $tree"
  elif [[ "$tree" != "$pinned" ]]; then
    echo "error: $tool's tree hashed to $tree, and builtin.json pins ${pinned:-nothing}" >&2
    exit 1
  fi
  zstd -q -15 -T1 "$work/tree.tar" -o "$out/tree.tar.zst"

  jq -n --slurpfile meta "$meta" '
    $meta[0] as $m | {
      kind: "builtin",
      name: $m.name,
      version: $m.version,
      abi: "node",
      module: "tree.tar.zst",
      args: ([$m.entry] + $m.args),
      env: $m.env,
      description: $m.description
    }' >"$out/build.json"
  echo "built $out ($(du -h "$out/tree.tar.zst" | cut -f1) from $(du -h "$work/tree.tar" | cut -f1))"
done
