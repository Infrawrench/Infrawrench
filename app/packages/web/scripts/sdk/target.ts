/**
 * The contract every SDK target implements.
 *
 * A target owns everything language-specific: how a `TypeRef` prints, how a
 * call prints, what the package manifest looks like, and whether the output
 * needs a compile step. The orchestrator only knows how to run one, where to
 * put the result, and how to tell whether that result is stale.
 *
 * To add a language, write one of these and register it in `./targets/index.ts`.
 */
import type { SdkIr } from "./types";

export interface TargetContext {
  /** Absolute path to this target's (already created, already emptied) output directory. */
  outDir: string;
  /** Write a file relative to `outDir`, creating parent directories as needed. */
  write(relPath: string, contents: string): Promise<void>;
  /** Progress output for the human running the generator. */
  log(message: string): void;
}

export interface SdkTarget {
  /** Directory name under the SDK root, and the value accepted by `--target`. */
  readonly id: string;
  readonly displayName: string;
  /** Package name the emitted artifact publishes under. */
  readonly packageName: string;
  /**
   * Files that must all exist for an output directory to count as complete.
   * A missing artifact forces regeneration even when the stamp says otherwise,
   * so a half-deleted output directory heals itself.
   */
  readonly artifacts: readonly string[];
  generate(ir: SdkIr, ctx: TargetContext): Promise<void>;
}
