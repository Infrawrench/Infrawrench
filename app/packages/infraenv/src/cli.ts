/**
 * The `infraenv` executable. Kept to the bare minimum so a git hook pays for
 * nothing but the command it runs: everything else is in `main.ts` and the
 * command chunks it imports on demand.
 */
import { processIo } from "./io";
import { run } from "./main";

const code = await run(process.argv.slice(2), processIo);
// Let pending stdout writes drain rather than calling process.exit().
process.exitCode = code;
