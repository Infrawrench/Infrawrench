// Metro config for a pnpm monorepo: watch the repo root and resolve modules
// from both the app's and the root node_modules. Package `exports` maps are
// enabled so workspace packages (@infrawrench/client-core, plugin-base)
// resolve their dist builds.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
