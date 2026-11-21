// The standalone CLI's entry point (`scripts/build-cli.mjs`): what
// `electron/index.ts` is for `--cli`, on plain Node. Every argument is the
// CLI's; there is no `--cli` marker and no app path to skip.
//
// Import order is the point: kill-emudhra before anything can open a TLS
// connection, and the deprecation switch before the modules that would print
// one (see `../../index.ts`).
import "kill-emudhra";
import "./quiet";
import { runCli } from "../main";

void runCli(process.argv.slice(2));
