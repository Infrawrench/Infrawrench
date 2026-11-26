/**
 * The languages a repository search can name, as a `<datalist>` a language
 * box points at with `list={LANGUAGE_OPTIONS_ID}`: the names the language bar
 * uses (contract `languages.ts`), so a search matches what repositories show.
 */
import { LANGUAGES } from "@infrawrench/git-contract";

export const LANGUAGE_OPTIONS_ID = "language-options";

export function LanguageOptions() {
  return (
    <datalist id={LANGUAGE_OPTIONS_ID}>
      {LANGUAGES.map((language) => (
        <option key={language.name} value={language.name} />
      ))}
    </datalist>
  );
}
