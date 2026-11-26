/**
 * Which language a file is, for a repository's language bar: what GitHub's
 * Linguist counts by default (programming and markup languages, not data,
 * prose or configuration), told apart by name and extension, and the colour
 * Linguist gives each. The Worker counts bytes with it; the UI colours the
 * bar and suggests names in the search with it.
 */

export interface LanguageInfo {
  readonly name: string;
  /** Linguist's colour. */
  readonly color: string;
  readonly extensions: readonly string[];
  /** Whole file names, lower-cased (`dockerfile`, `makefile`). */
  readonly filenames?: readonly string[];
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { name: "TypeScript", color: "#3178c6", extensions: ["ts", "tsx", "mts", "cts"] },
  { name: "JavaScript", color: "#f1e05a", extensions: ["js", "jsx", "mjs", "cjs"] },
  { name: "Python", color: "#3572A5", extensions: ["py", "pyi", "pyw"] },
  { name: "Rust", color: "#dea584", extensions: ["rs"] },
  { name: "Go", color: "#00ADD8", extensions: ["go"] },
  { name: "Java", color: "#b07219", extensions: ["java"] },
  { name: "Kotlin", color: "#A97BFF", extensions: ["kt", "kts"] },
  { name: "Swift", color: "#F05138", extensions: ["swift"] },
  { name: "Objective-C", color: "#438eff", extensions: ["m"] },
  { name: "C", color: "#555555", extensions: ["c", "h"] },
  { name: "C++", color: "#f34b7d", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ipp"] },
  { name: "C#", color: "#178600", extensions: ["cs"] },
  { name: "F#", color: "#b845fc", extensions: ["fs", "fsi", "fsx"] },
  {
    name: "Ruby",
    color: "#701516",
    extensions: ["rb", "rake", "gemspec"],
    filenames: ["rakefile", "gemfile"],
  },
  { name: "PHP", color: "#4F5D95", extensions: ["php"] },
  { name: "Perl", color: "#0298c3", extensions: ["pl", "pm"] },
  { name: "Lua", color: "#000080", extensions: ["lua"] },
  { name: "Dart", color: "#00B4AB", extensions: ["dart"] },
  { name: "Elixir", color: "#6e4a7e", extensions: ["ex", "exs"] },
  { name: "Erlang", color: "#B83998", extensions: ["erl", "hrl"] },
  { name: "Haskell", color: "#5e5086", extensions: ["hs", "lhs"] },
  { name: "OCaml", color: "#ef7a08", extensions: ["ml", "mli"] },
  { name: "Scala", color: "#c22d40", extensions: ["scala", "sc"] },
  { name: "Clojure", color: "#db5855", extensions: ["clj", "cljs", "cljc", "edn"] },
  { name: "Elm", color: "#60B5CC", extensions: ["elm"] },
  { name: "Groovy", color: "#4298b8", extensions: ["groovy", "gradle"] },
  { name: "Julia", color: "#a270ba", extensions: ["jl"] },
  { name: "R", color: "#198CE7", extensions: ["r"] },
  { name: "Zig", color: "#ec915c", extensions: ["zig"] },
  { name: "Nix", color: "#7e7eff", extensions: ["nix"] },
  { name: "Solidity", color: "#AA6746", extensions: ["sol"] },
  { name: "Shell", color: "#89e051", extensions: ["sh", "bash", "zsh", "ksh"] },
  { name: "PowerShell", color: "#012456", extensions: ["ps1", "psm1", "psd1"] },
  { name: "Batchfile", color: "#C1F12E", extensions: ["bat", "cmd"] },
  { name: "HCL", color: "#844FBA", extensions: ["tf", "tfvars", "hcl", "tofu"] },
  {
    name: "Dockerfile",
    color: "#384d54",
    extensions: ["dockerfile"],
    filenames: ["dockerfile", "containerfile"],
  },
  {
    name: "Makefile",
    color: "#427819",
    extensions: ["mk", "mak"],
    filenames: ["makefile", "gnumakefile"],
  },
  { name: "CMake", color: "#DA3434", extensions: ["cmake"], filenames: ["cmakelists.txt"] },
  {
    name: "Starlark",
    color: "#76d275",
    extensions: ["bzl", "star"],
    filenames: ["build.bazel", "workspace.bazel"],
  },
  { name: "HTML", color: "#e34c26", extensions: ["html", "htm"] },
  { name: "CSS", color: "#663399", extensions: ["css"] },
  { name: "SCSS", color: "#c6538c", extensions: ["scss"] },
  { name: "Less", color: "#1d365d", extensions: ["less"] },
  { name: "Vue", color: "#41b883", extensions: ["vue"] },
  { name: "Svelte", color: "#ff3e00", extensions: ["svelte"] },
  { name: "Astro", color: "#ff5a03", extensions: ["astro"] },
  { name: "Vim Script", color: "#199f4b", extensions: ["vim"] },
  { name: "Jupyter Notebook", color: "#DA5B0B", extensions: ["ipynb"] },
];

const BY_EXTENSION = new Map<string, LanguageInfo>();
const BY_FILENAME = new Map<string, LanguageInfo>();
const BY_NAME = new Map<string, LanguageInfo>();
for (const language of LANGUAGES) {
  for (const extension of language.extensions) BY_EXTENSION.set(extension, language);
  for (const filename of language.filenames ?? []) BY_FILENAME.set(filename, language);
  BY_NAME.set(language.name.toLowerCase(), language);
}

/** A language by its name, any case. */
export const languageNamed = (name: string): LanguageInfo | undefined =>
  BY_NAME.get(name.toLowerCase());

/** The colour of a language the bar shows; grey for one this table does not know. */
export const languageColor = (name: string): string => languageNamed(name)?.color ?? "#8b8b8b";

/**
 * Directories whose files are not the repository's own work, as Linguist's
 * vendored and documentation lists have them: dependencies, build output,
 * documentation. Matched against each directory name on the way down.
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "third-party",
  "dist",
  ".git",
  "docs",
  "doc",
  "documentation",
]);

export const isCountedDirectory = (name: string): boolean =>
  !SKIPPED_DIRECTORIES.has(name.toLowerCase());

/**
 * The language a file counts toward, or null for one that counts toward
 * none: unknown kinds, data and prose, minified and lock files.
 */
export function countedLanguageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/\.min\.(js|css)$/.test(name) || /\.(lock)$/.test(name) || name.endsWith("-lock.json")) {
    return null;
  }
  const byName = BY_FILENAME.get(name);
  if (byName) return byName.name;
  if (name.startsWith("dockerfile.")) return "Dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION.get(name.slice(dot + 1))?.name ?? null;
}
