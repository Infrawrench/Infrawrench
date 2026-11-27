// Minimal `node:fs` surface for the tests that read source files off disk.
//
// `@infrawrench/ui` ships to the browser and deliberately carries no
// `@types/node`: with tsconfig's `"types": ["*"]` that package would replace
// the DOM `setTimeout`/`clearTimeout` overloads with Node's across every file
// in the package. Declaring the two functions used here keeps that blast
// radius at zero. (`theme.css` cannot be pulled in with `?raw` instead:
// vitest stubs every `.css` request to an empty string unless CSS processing
// is enabled for the whole suite.)
declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  // For the test that runs the VM's shell scripts in a scratch home.
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { mode: number };
  export function writeFileSync(path: string, data: string): void;
}

// Imported as a module rather than declared as a global `process`, which
// would put a Node-shaped global in scope for every file in the package.
declare module "node:process" {
  export function cwd(): string;
  export const env: Record<string, string | undefined>;
}

// Where a test file is, for the tests that read this package's own sources:
// `fileURLToPath(import.meta.url)` and its `dirname`.
declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

// The one call the shell-script test makes, with the options it passes.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: {
      input?: string;
      env?: Record<string, string>;
      encoding?: "utf8";
      stdio?: "ignore" | readonly ("pipe" | "ignore")[];
    },
  ): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
