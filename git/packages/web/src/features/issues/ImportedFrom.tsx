import type { ImportedFrom } from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";

const SOURCE_NAME: Record<ImportedFrom["source"], string> = { github: "GitHub" };

export const importSourceName = (imported: ImportedFrom): string => SOURCE_NAME[imported.source];

/** The name shown for something imported whose author has no account here. */
export const importedAuthorName = (imported: ImportedFrom | null | undefined): string | null =>
  imported?.author ? `${imported.author} on ${importSourceName(imported)}` : null;

const external = { target: "_blank", rel: "noreferrer" } as const;

/** Who wrote an imported issue or comment at its source, linking to it there. */
export function ImportedAuthor({ imported }: { imported: ImportedFrom }) {
  const name = importedAuthorName(imported) ?? `Someone on ${importSourceName(imported)}`;
  return imported.url === null ? (
    <span>{name}</span>
  ) : (
    <AppLink href={imported.url} {...external} className="hover:text-on-surface hover:underline">
      {name}
    </AppLink>
  );
}

/** "Imported from GitHub", and the number it had there when that is not its number here. */
export function ImportedNote({ imported, number }: { imported: ImportedFrom; number: number }) {
  const source = importSourceName(imported);
  const label = `Imported from ${source}`;
  return (
    <span>
      ·{" "}
      {imported.url === null ? (
        label
      ) : (
        <AppLink
          href={imported.url}
          {...external}
          className="hover:text-on-surface hover:underline"
        >
          {label}
        </AppLink>
      )}
      {imported.number !== null && imported.number !== number
        ? ` · #${imported.number} on ${source}`
        : ""}
    </span>
  );
}
