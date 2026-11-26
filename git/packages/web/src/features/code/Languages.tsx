/**
 * A repository's languages, as GitHub's sidebar shows them: one bar split by
 * bytes in each language's colour, then each with its share. A language
 * links to Explore filtered by it.
 */
import { languageColor, type Repository } from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { paths } from "../../lib/paths";

/** Below this share a language is folded into "Other", as GitHub folds it. */
const SMALLEST_SHARE = 0.001;

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

export function Languages({ languages }: { languages: Repository["languages"] }) {
  const total = languages.reduce((sum, language) => sum + language.bytes, 0);
  if (total === 0) return null;
  const shown = languages.filter((language) => language.bytes / total >= SMALLEST_SHARE);
  const other = total - shown.reduce((sum, language) => sum + language.bytes, 0);
  const rows = [
    ...shown.map((language) => ({
      name: language.name,
      share: language.bytes / total,
      color: languageColor(language.name),
      href: paths.explore({ language: language.name }) as string | null,
    })),
    ...(other > 0
      ? [{ name: "Other", share: other / total, color: "#8b8b8b", href: null as string | null }]
      : []),
  ];
  return (
    <section aria-labelledby="languages-heading" className="space-y-2">
      <h2 id="languages-heading" className="text-sm font-semibold text-on-surface">
        Languages
      </h2>
      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-surface-sunken">
        {rows.map((row) => (
          <span
            key={row.name}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${row.share * 100}%`, backgroundColor: row.color, minWidth: 2 }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {rows.map((row) => {
          const label = (
            <>
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
              <span className="font-medium text-on-surface">{row.name}</span>
              <span className="text-on-surface-muted">{percent(row.share)}</span>
            </>
          );
          return (
            <li key={row.name}>
              {row.href !== null ? (
                <AppLink
                  href={row.href}
                  className="inline-flex items-center gap-1.5 hover:underline"
                >
                  {label}
                </AppLink>
              ) : (
                <span className="inline-flex items-center gap-1.5">{label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
