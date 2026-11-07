/** The shapes the plugin passes around, named from the generated types of each document. */
import type { ApiListItem } from "@infrawrench/plugin-base";
import type {
  components as AbTesting,
  operations as AbTestingOps,
} from "./api-types.abtesting-v3.gen.js";
import type {
  components as AbTestingV2,
  operations as AbTestingV2Ops,
} from "./api-types.abtesting.gen.js";
import type { components as Crawler, operations as CrawlerOps } from "./api-types.crawler.gen.js";
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

/** A variant from either route: `/3` reports `metrics`, `/2` a field per rate. */
export type AlAbTestVariant = Partial<AbTesting["schemas"]["variant"]> &
  Partial<Pick<AbTestingV2["schemas"]["variant"], "clickThroughRate">>;

/** `abTestID` identifies a test; one just created has no statistics to report yet. */
type FetchedAbTest = ApiListItem<AbTestingOps["listABTests"], "abtests">;
type FetchedAbTestV2 = ApiListItem<AbTestingV2Ops["listABTests"], "abtests">;
export type AlAbTest = Pick<FetchedAbTest, "abTestID"> &
  Partial<Omit<FetchedAbTest, "variants" | "configuration">> &
  Partial<Pick<FetchedAbTestV2, "clickSignificance" | "conversionSignificance">> & {
    variants?: AlAbTestVariant[];
  };

/** A page of A/B tests from either route. */
export interface AlAbTestPage {
  abtests: AlAbTest[] | null;
  total: number;
}

/**
 * A crawler's detail.
 * The document says `lastReindexStartAt`. `lastReindexStartedAt` is what was read before
 * that was noticed, and is still read because no live answer has ruled it out.
 */
export type AlCrawler = Partial<Crawler["schemas"]["BaseResponse"]> & {
  config?: Crawler["schemas"]["Configuration"];
  lastReindexStartedAt?: string | null;
};

/** A crawler's row in the list, which has little beyond its id. */
export type AlCrawlerRow = ApiListItem<CrawlerOps["listCrawlers"], "items">;

/** One point of the Usage API, which has no published document. */
export interface AlUsagePoint {
  t: number;
  v: number | Record<string, number>;
}
