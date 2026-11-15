import { builtinModules } from "node:module";
import { defineConfig } from "vitest/config";

/*
 * What the setup file imports, bundled once per run into a few files each
 * (Vite's dependency optimizer) instead of being read module by module in
 * every test file's process. Vitest starts a `node` per test file, and on
 * Infrawrench CI's runner each module read costs about a millisecond: these
 * three are some 390 module files in each of the 118 test files, 65 s of a
 * run between them. server-core/vitest.prebundle.ts has the rules a list like
 * this follows; what is particular to this one:
 *
 * - It is the `client` optimizer: this suite's files all run in jsdom, which
 *   is Vite's `client` environment (desktop's and web's lists are `ssr`).
 *   There the optimizer resolves what a listed package imports as a browser
 *   bundler would (`browser` fields and conditions), where Node, which loaded
 *   those packages before, takes the `node` and default ones. So a package
 *   belongs here only if its bundle holds the files Node loaded: recharts
 *   (the CommonJS builds of Redux Toolkit and what it uses, where Node loads
 *   their ES builds), react-markdown and remark-gfm (vfile's and the entity
 *   decoder's browser builds, the second of which parses with the document),
 *   plugin-base (Smithy's browser builds under the request signer) and
 *   `@monaco-editor/react` (its loader's CommonJS build) all differ. To check
 *   a new entry, compare the `sources` of the maps in
 *   `node_modules/.vite/vitest/<hash>/deps` with what Node loads without it.
 * - Node loads the bundles itself, so what a bundle imports and does not hold
 *   is Node's copy of it, while the source under test and the workspace
 *   packages' dist reach theirs through Vite. That is the same module for an
 *   npm package, which Vite hands to Node, and two for a workspace package:
 *   with client-core listed (189 files in each of 73 test files, the next
 *   largest) its bundle imported a plugin-base of its own beside the one the
 *   components import, and bundling plugin-base too is ruled out above. So
 *   no workspace package is listed.
 * - React is never bundled. recharts, `@dnd-kit` and everything else left out
 *   import the React that Node loads, and a second copy in the bundles would
 *   be a second set of hooks; `exclude` leaves each import of it in the
 *   bundles as an import.
 *
 * A `vi.mock` of `gt-react` still reaches the source under test, which is all
 * that imports it.
 */
const prebundled = ["@testing-library/react", "@testing-library/jest-dom/vitest", "gt-react"];

const notBundled = [
  ...builtinModules,
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "react-dom/test-utils",
];

/*
 * A constant rather than a literal in the config: `force` is Vite's option,
 * which Vitest hands on to the optimizer but leaves out of its own type. It
 * rebuilds the bundles on every run, because the optimizer's cache is not
 * keyed on a workspace package's dist.
 */
const prebundle = { enabled: true, force: true, include: prebundled, exclude: notBundled };

export default defineConfig({
  // gt-react ships separate server and browser entries behind export
  // conditions; without "browser" Vitest resolves the server one, whose
  // initializeGTSPA() refuses to run. The tests render in jsdom, so the
  // browser build is the right one everywhere.
  resolve: {
    conditions: ["browser"],
  },
  test: {
    // Vitest's jsdom environment, with jsdom itself read from one file that
    // the global setup writes before the first test (vitest.environment.ts).
    environment: "./vitest.environment.ts",
    globalSetup: ["./vitest.jsdom-bundle.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    deps: { optimizer: { client: prebundle } },
    // jsdom + RTL under a saturated `turbo test` regularly overruns the 5s
    // default even for trivial renders; keep the suite green at the cost of a
    // slower failure signal.
    testTimeout: 20_000,
  },
});
