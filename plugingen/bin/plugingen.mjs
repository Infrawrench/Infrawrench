#!/usr/bin/env node
// In this process rather than through a `tsx` child, and with no pnpm in between,
// so that nothing here touches the install and several can run at once.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
