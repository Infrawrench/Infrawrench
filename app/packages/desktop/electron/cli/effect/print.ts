// `output.ts`'s printers as Effects, so a command's body stays one
// generator. The formatting (colour, `safe`, tables) is still `output.ts`'s:
// wrap API strings in `safe()` before handing them here, as everywhere else.
import { Effect } from "effect";
import {
  type Column,
  printErr,
  printJson,
  printKeyValues,
  println,
  printTable,
  type TableOptions,
} from "../output";

export const line = (text = ""): Effect.Effect<void> => Effect.sync(() => println(text));

export const errLine = (text: string): Effect.Effect<void> => Effect.sync(() => printErr(text));

export const json = (value: unknown): Effect.Effect<void> => Effect.sync(() => printJson(value));

export const table = <T>(
  rows: ReadonlyArray<T>,
  columns: Column<T>[],
  options?: TableOptions,
): Effect.Effect<void> => Effect.sync(() => printTable([...rows], columns, options));

export const keyValues = (pairs: Array<[string, string]>): Effect.Effect<void> =>
  Effect.sync(() => printKeyValues(pairs));

/**
 * Text (or a file's bytes) exactly as given, no newline added: a document a
 * command passes through.
 */
export const write = (text: string | Uint8Array): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(text);
  });
