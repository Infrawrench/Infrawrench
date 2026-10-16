import { useGT } from "gt-react";
import {
  SEARCH_KIND_LABELS,
  SEARCH_OBJECT_PLUGIN_ID,
  isSearchObjectKind,
  type SearchResult,
  type StarRef,
} from "@infrawrench/client-core";
import { toast } from "../components/Toast/useToast.js";
import { formatErrorMessage } from "../utils.js";
import { isStarred, toggleStar, usePaletteHost, useStarredItems } from "./host.js";
import { paletteShortcutLabel } from "./keys.js";

/** A placeholder hit for an optimistic star, until the server's copy lands. */
export function starHit(ref: StarRef, name: string, extra?: Partial<SearchResult>): SearchResult {
  const label = SEARCH_KIND_LABELS[ref.kind];
  return {
    id: ref.id,
    kind: ref.kind,
    pluginId: isSearchObjectKind(ref.kind) ? SEARCH_OBJECT_PLUGIN_ID : "",
    pluginDisplayName: label.plural,
    pluginLogoSvg: "",
    resourceTypeId: ref.kind,
    resourceTypeLabel: label.singular,
    accountId: "",
    accountName: "",
    displayName: name,
    ...extra,
  };
}

export interface StarButtonProps {
  starRef: StarRef;
  /** The object's name, shown in the palette's Starred list right away. */
  name: string;
  /** Anything else the optimistic row needs to open (a resource's account). */
  hit?: Partial<SearchResult> | undefined;
  className?: string | undefined;
}

/**
 * The page-header star: a toggle button (`aria-pressed`) that adds the object
 * to the member's Starred list, the first thing the command palette shows.
 * Renders nothing without a cloud palette host (desktop local mode), since
 * stars are kept server-side per member.
 */
export function StarButton({ starRef, name, hit, className }: StarButtonProps) {
  const gt = useGT();
  const host = usePaletteHost();
  const items = useStarredItems();
  if (!host?.client) return null;
  const starred = isStarred(items, starRef);
  const label = starred ? gt("Unstar {name}", { name }) : gt("Star {name}", { name });

  return (
    <button
      type="button"
      aria-pressed={starred}
      aria-label={label}
      title={
        starred
          ? gt("Starred: listed first in {shortcut}", { shortcut: paletteShortcutLabel() })
          : gt("Star to list it first in {shortcut}", { shortcut: paletteShortcutLabel() })
      }
      disabled={items === null}
      onClick={() => {
        toggleStar(host, starRef, starHit(starRef, name, hit)).catch((e: unknown) =>
          toast.error(
            gt("Couldn't update the star: {message}", { message: formatErrorMessage(e) }),
          ),
        );
      }}
      className={`inline-flex size-7 items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-surface-overlay disabled:opacity-50 ${
        starred ? "text-warning" : "text-on-surface-faint hover:text-on-surface-secondary"
      } ${className ?? ""}`}
    >
      <span aria-hidden="true">{starred ? "★" : "☆"}</span>
    </button>
  );
}
