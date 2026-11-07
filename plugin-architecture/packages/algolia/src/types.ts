/** The shapes the plugin passes around, named from the generated types of each document. */
import type { ApiListItem } from "@infrawrench/plugin-base";
import type {
  components as AbTesting,
  operations as AbTestingOps,
} from "./api-types.abtesting.gen.js";
import type { components as Crawler } from "./api-types.crawler.gen.js";
import type { components as Search, operations as SearchOps } from "./api-types.search.gen.js";

/**
 * Only `name` is certain: a created index is mapped before it has been listed.
 * The document names a test's id `id`. `abTestId` is what was read before that was
 * noticed, and is still read because no live answer has ruled it out.
 */
type FetchedIndex = ApiListItem<SearchOps["listIndices"], "items">;
export type AlIndex = Pick<FetchedIndex, "name"> &
  Partial<Omit<FetchedIndex, "abTest">> & {
    abTest?: Partial<NonNullable<FetchedIndex["abTest"]>> & { abTestId?: number };
  };

/** Index settings (`GET /1/indexes/{name}/settings`); open-ended, only some are mapped. */
export type AlSettings = Search["schemas"]["settingsResponse"];

/** What `PUT /1/indexes/{name}/settings` takes. */
export type AlSettingsPatch = Search["schemas"]["indexSettings"];

/** `value` identifies a key; a key mapped from what was just sent has nothing else certain. */
type FetchedApiKey = ApiListItem<SearchOps["listApiKeys"], "keys">;
export type AlApiKey = Pick<FetchedApiKey, "value"> & Partial<FetchedApiKey>;

/** What `POST /1/keys` and `PUT /1/keys/{key}` take. */
export type AlApiKeyBody = Search["schemas"]["apiKey"];

export type AlAcl = Search["schemas"]["acl"];

/** `abTestID` identifies a test; one just created has no statistics to report yet. */
type FetchedAbTest = ApiListItem<AbTestingOps["listABTests"], "abtests">;
export type AlAbTest = Pick<FetchedAbTest, "abTestID"> &
  Partial<Omit<FetchedAbTest, "variants">> & {
    variants?: Partial<AbTesting["schemas"]["variant"]>[];
  };

/**
 * A crawler's detail, or as little as its row in the list when that fails.
 * `lastReindexStartedAt` is what the mapper reads, where the document says `lastReindexStartAt`.
 */
export type AlCrawler = Partial<Crawler["schemas"]["BaseResponse"]> & {
  config?: Crawler["schemas"]["Configuration"];
  lastReindexStartedAt?: string | null;
};

/** One point of the Usage API, which has no published document. */
export interface AlUsagePoint {
  t: number;
  v: number | Record<string, number>;
}
