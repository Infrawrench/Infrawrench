// Builds the standalone `infrawrench` CLI: the desktop app's CLI
// (`electron/cli/`) as one CommonJS file that runs on plain Node 22+, with no
// Electron and nothing to install beside it. The npm package runs that file
// on the user's Node; `scripts/package-cli.mjs` embeds it in a Node single
// executable for the release archives and the .deb.
//
//   node scripts/build-cli.mjs            # production endpoints (env.production.ts)
//   node scripts/build-cli.mjs --dev      # this checkout's env.ts
//   node scripts/build-cli.mjs --out dir  # somewhere other than out/cli
//
// Three kinds of module are swapped (KNOWLEDGE.md "Standalone CLI"):
//
// - `electron` is `electron/cli/standalone/electron.ts`, a Node stand-in for
//   the few members the CLI's shared modules use.
// - DESKTOP_ONLY_MODULES (the local workspace and what drives the desktop
//   app) are `electron/cli/standalone/desktop-only.cjs`. That is what keeps
//   every provider SDK out: the bundle is a few MB instead of ~60.
// - REPLACED modules get a standalone version (sql.js with its WebAssembly
//   inlined, the production endpoints).
//
// The build fails if an input matches FORBIDDEN_INPUTS, so a new import that
// drags a desktop-only module back in is caught here rather than as a 50 MB
// executable.
import { build } from "esbuild-wasm";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Desktop-only modules, from the package root: each resolves to the stub. */
export const DESKTOP_ONLY_MODULES = [
  "electron/plugin-runtime.ts",
  "electron/local-posture.ts",
  "electron/local-expiring.ts",
  "electron/local-extended-support.ts",
  "electron/local-environment-diff.ts",
  "electron/local-orphans.ts",
  "electron/local-dns.ts",
  "electron/ssh-shell.ts",
  "electron/iwappd-archive.ts",
  "electron/shell-command.ts",
  "src/plugins/loader.ts",
  // DESKTOP_ONLY_COMMANDS (`electron/cli/effect/commands.ts`): never loaded here.
  "electron/cli/commands/apps.ts",
  "electron/cli/commands/cli-install.ts",
];

/** Inputs that mean a desktop-only module came back in through another path. */
export const FORBIDDEN_INPUTS = [
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?@kubernetes[\\/]/,
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?@aws-sdk[\\/]/,
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?ssh2[\\/]/,
  /[\\/]plugin-architecture[\\/]packages[\\/](?!plugin-base[\\/])[^\\/]+[\\/]/,
  /[\\/]electron[\\/]local-[a-z-]+\.ts$/,
  /[\\/]electron[\\/]plugin-runtime\.ts$/,
];

const STUB = resolve(root, "electron/cli/standalone/desktop-only.cjs");

function parseArgs(argv) {
  const options = { dev: false, out: resolve(root, "out/cli") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dev") options.dev = true;
    else if (argv[i] === "--out") options.out = resolve(argv[++i]);
    else throw new Error(`build-cli: unknown argument ${argv[i]}`);
  }
  return options;
}

/** The module a relative import names, the way TypeScript resolves it here. */
function resolveSource(from, spec) {
  const base = resolve(from, spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The licence of every npm package the bundle inlines, for the archives, the
 * .deb and the npm package: the bundle is a copy of their code.
 */
function thirdPartyLicenses(metafile) {
  const roots = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input);
    if (match) roots.set(resolve(root, match[1]), true);
  }
  const sections = [];
  for (const dir of [...roots.keys()].sort()) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof pkg.name !== "string" || pkg.name.startsWith("@infrawrench/")) continue;
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = file
      ? readFileSync(resolve(dir, file), "utf8").trim()
      : `License: ${pkg.license ?? "unknown"}`;
    sections.push(`${pkg.name}@${pkg.version}\n\n${text}`);
  }
  const unique = [...new Set(sections)];
  return `The standalone Infrawrench CLI includes the following packages.\n\n${unique.join(`\n\n${"-".repeat(72)}\n\n`)}\n`;
}

export async function buildCli({ dev = false, out = resolve(root, "out/cli") } = {}) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const envFile = dev ? "env.ts" : "env.production.ts";
  if (!existsSync(resolve(root, envFile))) {
    throw new Error(`build-cli: ${envFile} is missing (run scripts/ensure-env.mjs)`);
  }
  const replaced = new Map([
    [resolve(root, "electron/sql-js.ts"), resolve(root, "electron/cli/standalone/sql-js.ts")],
    [resolve(root, "env.ts"), resolve(root, envFile)],
  ]);
  const desktopOnly = new Set(DESKTOP_ONLY_MODULES.map((m) => resolve(root, m)));

  const swap = {
    name: "standalone-cli",
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({
        path: resolve(root, "electron/cli/standalone/electron.ts"),
      }));
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.importer.includes("node_modules")) return undefined;
        // A replaced module may not exist at all: `env.ts` is gitignored and
        // generated, so a fresh checkout (the release runners) has none.
        const base = resolve(args.resolveDir, args.path);
        for (const candidate of [base, `${base}.ts`]) {
          const swapped = replaced.get(candidate);
          if (swapped) return { path: swapped };
        }
        const target = resolveSource(args.resolveDir, args.path);
        if (!target) return undefined;
        if (desktopOnly.has(target)) return { path: STUB };
        return undefined;
      });
    },
  };

  mkdirSync(out, { recursive: true });
  const outfile = resolve(out, "infrawrench.cjs");
  const result = await build({
    entryPoints: [resolve(root, "electron/cli/standalone/entry.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // Names stay, so a stack trace from a bug still reads.
    minifySyntax: true,
    minifyWhitespace: true,
    legalComments: "external",
    loader: { ".wasm": "binary" },
    define: {
      __INFRAWRENCH_STANDALONE_CLI__: "true",
      __INFRAWRENCH_CLI_VERSION__: JSON.stringify(pkg.version),
    },
    banner: { js: "#!/usr/bin/env node" },
    plugins: [swap],
    metafile: true,
    logLevel: "warning",
    // A Node single executable can only `require` built-ins, so nothing may
    // stay external.
    external: [],
  });

  const forbidden = Object.keys(result.metafile.inputs).filter((input) =>
    FORBIDDEN_INPUTS.some((re) => re.test(resolve(root, input))),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `build-cli: desktop-only code reached the standalone bundle:\n  ${forbidden.slice(0, 20).join("\n  ")}\n` +
        "Add the module that imports it to DESKTOP_ONLY_MODULES in scripts/build-cli.mjs, or import it lazily behind a desktop-only path.",
    );
  }
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(result.metafile));
  writeFileSync(resolve(out, "THIRD_PARTY_LICENSES.txt"), thirdPartyLicenses(result.metafile));
  return { outfile, version: pkg.version, inputs: Object.keys(result.metafile.inputs).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const { outfile, version, inputs } = await buildCli(options);
  console.log(`build-cli: ${relative(process.cwd(), outfile)} (v${version}, ${inputs} modules)`);
}
