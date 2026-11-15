import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import { builtinEnvironments } from "vitest/runtime";
import type { Environment } from "vitest/runtime";
import { JSDOM_BUNDLE } from "./vitest.jsdom-bundle";

/*
 * Vitest's own jsdom environment, loading jsdom from one file.
 *
 * Vitest starts a `node` per test file, and its jsdom environment imports
 * jsdom in each: 937 module files (jsdom 635, css-tree 125, undici 110). On
 * Infrawrench CI's runner, where reading a module costs about a millisecond,
 * that was most of the suite: 228 s of environment setup in a 267 s run.
 * vitest.jsdom-bundle.ts writes the same modules into one file before the
 * first test, and this sends the environment's `import("jsdom")` there.
 *
 * Everything else is Vitest's: this object is its jsdom environment with a
 * `setup` that registers the redirect first, so the window, the globals it
 * copies and the teardown are the ones `environment: "jsdom"` gives.
 *
 * The redirect is a resolve hook (`module.registerHooks`, Node 22.15 and
 * later) for the bare specifier `jsdom`, which only the environment imports:
 * a test file's own import of a package reaches Node as a resolved path. On
 * an older Node, or without the bundle, the environment loads the package as
 * it always did.
 */
const jsdom = builtinEnvironments.jsdom;
let redirected = false;

function loadJsdomFromBundle() {
  if (redirected) return;
  redirected = true;
  if (typeof nodeModule.registerHooks !== "function" || !existsSync(JSDOM_BUNDLE)) return;
  const url = pathToFileURL(JSDOM_BUNDLE).href;
  nodeModule.registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === "jsdom"
        ? { url, format: "commonjs", shortCircuit: true }
        : nextResolve(specifier, context),
  });
}

export default {
  ...jsdom,
  setup(global, options) {
    loadJsdomFromBundle();
    return jsdom.setup(global, options);
  },
} satisfies Environment;
