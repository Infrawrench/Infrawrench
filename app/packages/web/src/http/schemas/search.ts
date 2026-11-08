/**
 * A search hit and its kind, shared by `/search` and `/starred` (a star is a
 * hit resolved fresh, plus when it was starred), so the components are
 * defined once.
 *
 * `/search` without `kinds` is the editor extensions' and mobile's contract
 * (CLAUDE.md "Editor extensions"): the hit's shape is fixed by
 * `SearchResult` in `@infrawrench/client-core`.
 */
import { Schema } from "effect";
import { SEARCH_OBJECT_KINDS, SEARCH_RESULT_KINDS } from "@infrawrench/client-core";
import { IsoDateTime, ResourceId } from "./common";

export const SearchResultKind = Schema.Literals(SEARCH_RESULT_KINDS).annotate({
  identifier: "SearchResultKind",
  description:
    "What a search hit is. `resource` and `workflow` are the original kinds; the rest are " +
    "saved objects (" +
    SEARCH_OBJECT_KINDS.join(", ") +
    "), returned only when asked for with `kinds`.",
});

const searchHitFields = {
  id: ResourceId,
  pluginId: Schema.String.annotate({
    description:
      "The provider plugin; `__workflows__` for workflows, `__objects__` for saved objects.",
  }),
  pluginDisplayName: Schema.String,
  pluginLogoSvg: Schema.String.annotate({
    description: "Inline SVG markup; empty for saved objects.",
  }),
  resourceTypeId: Schema.String.annotate({
    description: "The resource type; `__workflow__` for workflows, the kind for saved objects.",
  }),
  resourceTypeLabel: Schema.String,
  // Empty for non-resource hits (workflows and saved objects).
  accountId: Schema.String,
  accountName: Schema.String,
  displayName: Schema.String,
  subtitle: Schema.optionalKey(Schema.String),
};

export const SearchHit = Schema.Struct({
  ...searchHitFields,
  // Present on every hit. Optional only so that clients generated before it
  // existed keep validating. (Undescribed in the document: a description
  // beside the `$ref` would turn it into an `allOf`.)
  kind: Schema.optionalKey(SearchResultKind),
}).annotate({ identifier: "SearchHit" });

export const StarredItem = Schema.Struct({
  ...searchHitFields,
  kind: SearchResultKind,
  starredAt: IsoDateTime,
}).annotate({ identifier: "StarredItem" });
