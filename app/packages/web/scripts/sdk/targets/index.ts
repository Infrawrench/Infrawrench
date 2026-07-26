/**
 * The target registry.
 *
 * Adding a language is: write a `SdkTarget` under `./<language>/`, import it
 * here, add it to the array. Nothing else in the generator knows what languages
 * exist — the CLI's `--target` flag, the per-target output directories, and the
 * staleness stamps are all driven off this list.
 *
 * Order is display order (`--list`, and the sequence `generate:sdk` builds in).
 * TypeScript leads because it's the reference implementation; the rest follow
 * alphabetically.
 */
import type { SdkTarget } from "../target";
import { typescriptTarget } from "./typescript/index";
import { csharpTarget } from "./csharp/index";
import { goTarget } from "./go/index";
import { javaTarget } from "./java/index";
import { phpTarget } from "./php/index";
import { pythonTarget } from "./python/index";
import { rubyTarget } from "./ruby/index";
import { rustTarget } from "./rust/index";
import { swiftTarget } from "./swift/index";

export const SDK_TARGETS: readonly SdkTarget[] = [
  typescriptTarget,
  csharpTarget,
  goTarget,
  javaTarget,
  phpTarget,
  pythonTarget,
  rubyTarget,
  rustTarget,
  swiftTarget,
];

export function findTarget(id: string): SdkTarget | undefined {
  return SDK_TARGETS.find((target) => target.id === id);
}
