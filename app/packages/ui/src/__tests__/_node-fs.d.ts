// Minimal `node:fs` surface for the tests that read source files off disk.
//
// `@infrawrench/ui` ships to the browser and deliberately carries no
// `@types/node`: with tsconfig's `"types": ["*"]` that package would replace
// the DOM `setTimeout`/`clearTimeout` overloads with Node's across every file
// in the package. Declaring the two functions used here keeps that blast
// radius at zero. (`theme.css` cannot be pulled in with `?raw` instead —
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
}

// Imported as a module rather than declared as a global `process`, which
// would put a Node-shaped global in scope for every file in the package.
declare module "node:process" {
  export function cwd(): string;
}
