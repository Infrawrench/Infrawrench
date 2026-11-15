import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * jsdom and everything it loads, written into one file before the first test
 * (a Vitest `globalSetup`), so each test file's process reads one module for
 * its DOM instead of 937. vitest.environment.ts has why and loads it.
 *
 * It is the modules Node would have loaded, concatenated: resolved as Node
 * resolves them (`platform: "node"`, so a package's `node` build and never
 * its `browser` one), nothing left out (`treeshake: false`) and nothing
 * rewritten but three ways a module asks where it is, which would otherwise
 * point at the bundle:
 *
 * - `__dirname`: jsdom reads its default stylesheet from a path beside the
 *   module that computes styles.
 * - `require.resolve("./…")`: jsdom's synchronous XMLHttpRequest starts a
 *   child process from a file beside it, which then loads the package itself.
 * - `import.meta.url`: css-tree's ES build reads its JSON data through
 *   `createRequire(import.meta.url)`.
 *
 * Each becomes the path the module had. The bundler is tsdown (Rolldown),
 * which this package already builds with; it takes about half a second, and
 * two on Infrawrench CI's runner.
 */
const outDir = join(dirname(fileURLToPath(import.meta.url)), "node_modules", ".vite", "jsdom");

/** Where the run's one-file jsdom is. */
export const JSDOM_BUNDLE = join(outDir, "jsdom.cjs");

export default async function bundleJsdom() {
  const require = createRequire(import.meta.url);
  const api = require.resolve("jsdom");
  // The entry names jsdom's exports one by one: Node finds the names a
  // CommonJS file exports by reading it, and `module.exports = require(…)`
  // of something inside the bundle would give it none.
  const names = [...readFileSync(api, "utf8").matchAll(/^exports\.(\w+) = /gm)].map((m) => m[1]);
  const entry = join(outDir, "entry.cjs");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    entry,
    [
      `const api = require(${JSON.stringify(api)});`,
      ...names.map((name) => `exports.${name} = api.${name};`),
    ].join("\n"),
  );

  // Imported here, not at the top: every test file's process loads this
  // module for `JSDOM_BUNDLE`, and none of them bundles anything.
  const { build } = await import("tsdown");
  await build({
    config: false,
    tsconfig: false,
    entry: { jsdom: entry },
    outDir,
    outExtensions: () => ({ js: ".cjs" }),
    format: "cjs",
    platform: "node",
    target: false,
    deps: { alwaysBundle: () => true, onlyBundle: false },
    treeshake: false,
    sourcemap: false,
    dts: false,
    clean: false,
    report: false,
    logLevel: "warn",
    plugins: [
      {
        name: "where-a-module-is",
        transform(code: string, id: string) {
          if (!/__dirname|require\.resolve\(|import\.meta\.url/.test(code)) return null;
          const from = createRequire(id);
          return code
            .replaceAll("__dirname", JSON.stringify(dirname(id)))
            .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(id).href))
            .replace(/require\.resolve\((["'])(\.[^"']+)\1\)/g, (_, _quote, path: string) =>
              JSON.stringify(from.resolve(path)),
            );
        },
      },
    ],
  });
}
