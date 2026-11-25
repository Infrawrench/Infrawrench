/**
 * Syntax highlighting with Shiki, loaded on demand: the core and the two
 * themes on the first file that needs them, and each grammar on the first
 * file in that language. Nothing here is in the first download; a page shows
 * its text plain and colours it when the tokens arrive.
 *
 * Tokens carry both themes' colours; `globals.css` picks one by colour scheme
 * (`.tok`), so nothing re-highlights when the scheme changes.
 */
import { useEffect, useState } from "react";
import type { HighlighterCore } from "shiki/core";

type GrammarModule = Promise<{ default: unknown }>;

/** The grammars this site ships, by Shiki language id. Add a language here and in `EXTENSIONS`. */
const GRAMMARS: Record<string, () => GrammarModule> = {
  astro: () => import("shiki/langs/astro.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

const EXTENSIONS: Record<string, string> = {
  astro: "astro",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  diff: "diff",
  patch: "diff",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  hcl: "hcl",
  html: "html",
  htm: "html",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  mk: "makefile",
  md: "markdown",
  markdown: "markdown",
  nix: "nix",
  php: "php",
  ps1: "powershell",
  proto: "proto",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  scss: "scss",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  tf: "terraform",
  tfvars: "terraform",
  toml: "toml",
  tsx: "tsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  vue: "vue",
  xml: "xml",
  svg: "xml",
  yml: "yaml",
  yaml: "yaml",
  zig: "zig",
};

const FILENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "nginx.conf": "nginx",
  ".bashrc": "bash",
  ".zshrc": "bash",
  "tsconfig.json": "jsonc",
  ".terraform.lock.hcl": "hcl",
};

/** Names a fenced code block may use that are not a grammar id. */
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  yml: "yaml",
  tf: "terraform",
  golang: "go",
  docker: "dockerfile",
  make: "makefile",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  protobuf: "proto",
};

/** The grammar for a file path, or null when it is shown plain. */
export function languageOfPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = FILENAMES[name];
  if (byName !== undefined) return byName;
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1)] ?? null;
}

/** The grammar for a fenced code block's info string, or null. */
export function languageOfFence(info: string): string | null {
  const name = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (name === "") return null;
  const id = ALIASES[name] ?? name;
  return id in GRAMMARS ? id : null;
}

export interface Token {
  readonly content: string;
  /** Colour in the light scheme, or undefined for the default text colour. */
  readonly light: string | undefined;
  readonly dark: string | undefined;
  readonly italic: boolean;
}

/** One array of tokens per line of the text. */
export type TokenLines = ReadonlyArray<ReadonlyArray<Token>>;

/** Files past either limit are shown plain: tokenising them would stall the page. */
export const HIGHLIGHT_MAX_BYTES = 400_000;
export const HIGHLIGHT_MAX_LINE = 2_000;

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
  );
  return core;
}

/** The tokens of `code` in `language`, or null when it cannot or should not be highlighted. */
export async function highlight(code: string, language: string | null): Promise<TokenLines | null> {
  if (language === null || !(language in GRAMMARS)) return null;
  if (code.length > HIGHLIGHT_MAX_BYTES) return null;
  if (code.split("\n").some((line) => line.length > HIGHLIGHT_MAX_LINE)) return null;
  try {
    const shiki = await highlighter();
    let ready = loaded.get(language);
    if (!ready) {
      // The cast is the grammar module's own type, which Shiki's loader takes.
      ready = shiki.loadLanguage(GRAMMARS[language]!() as Parameters<typeof shiki.loadLanguage>[0]);
      loaded.set(language, ready);
    }
    await ready;
    const lines = shiki.codeToTokensWithThemes(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
    });
    return lines.map((line) =>
      line.map((token) => ({
        content: token.content,
        light: token.variants.light?.color,
        dark: token.variants.dark?.color,
        italic: ((token.variants.light?.fontStyle ?? 0) & 1) === 1,
      })),
    );
  } catch {
    // A grammar that fails to load or a pattern the engine cannot run: plain text.
    return null;
  }
}

/**
 * The tokens of `code`, or null until they arrive (and when the text is shown
 * plain). Render the plain lines first and swap the tokens in.
 */
export function useHighlight(code: string | null, language: string | null): TokenLines | null {
  const [result, setResult] = useState<{
    code: string;
    language: string | null;
    lines: TokenLines | null;
  } | null>(null);
  useEffect(() => {
    if (code === null || language === null) return;
    let current = true;
    void highlight(code, language).then((lines) => {
      if (current) setResult({ code, language, lines });
    });
    return () => {
      current = false;
    };
  }, [code, language]);
  return result !== null && result.code === code && result.language === language
    ? result.lines
    : null;
}
