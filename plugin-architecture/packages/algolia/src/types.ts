/** Algolia wire shapes. Only the fields this plugin reads. */

export interface AlIndex {
  name: string;
  createdAt?: string;
  updatedAt?: string;
  entries?: number;
  dataSize?: number;
  fileSize?: number;
  lastBuildTimeS?: number;
  numberOfPendingTasks?: number;
  pendingTask?: boolean;
  primary?: string;
  replicas?: string[];
  virtual?: boolean;
  abTest?: { abTestId?: number };
  sourceABTest?: string;
}

/** Index settings (`GET /1/indexes/{name}/settings`); open-ended, only some are mapped. */
export interface AlSettings {
  searchableAttributes?: string[] | null;
  attributesForFaceting?: string[] | null;
  attributesToRetrieve?: string[] | null;
  unretrievableAttributes?: string[] | null;
  customRanking?: string[] | null;
  ranking?: string[] | null;
  replicas?: string[] | null;
  hitsPerPage?: number;
  paginationLimitedTo?: number;
  typoTolerance?: boolean | string;
  distinct?: boolean | number;
  ignorePlurals?: boolean | string[];
  removeStopWords?: boolean | string[];
  queryLanguages?: string[] | null;
  indexLanguages?: string[] | null;
  enableRules?: boolean;
  enablePersonalization?: boolean;
  queryType?: string;
  removeWordsIfNoResults?: string;
  mode?: string;
  attributeForDistinct?: string | null;
  [k: string]: unknown;
}

export interface AlApiKey {
  value: string;
  /** Milliseconds since the epoch. */
  createdAt?: number;
  acl?: string[];
  description?: string;
  indexes?: string[];
  maxHitsPerQuery?: number;
  maxQueriesPerIPPerHour?: number;
  queryParameters?: string;
  referers?: string[];
  validity?: number;
}

export interface AlSource {
  source: string;
  description?: string;
}

export interface AlLogEntry {
  timestamp?: string;
  method?: string;
  answer_code?: string;
  url?: string;
  ip?: string;
  processing_time_ms?: string;
  index?: string;
  query_nb_hits?: string;
  nb_api_calls?: string;
}

export interface AlAbVariant {
  index?: string;
  trafficPercentage?: number;
  description?: string;
  searchCount?: number | null;
  clickThroughRate?: number | null;
  conversionRate?: number | null;
  noResultCount?: number | null;
  userCount?: number | null;
}

export interface AlAbTest {
  abTestID: number;
  name?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  endAt?: string;
  stoppedAt?: string | null;
  clickSignificance?: number | null;
  conversionSignificance?: number | null;
  variants?: AlAbVariant[];
}

export interface AlCrawler {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  running?: boolean;
  reindexing?: boolean;
  blocked?: boolean;
  blockingError?: string;
  blockingTaskId?: string;
  lastReindexStartedAt?: string | null;
  lastReindexEndedAt?: string | null;
  config?: {
    appId?: string;
    indexPrefix?: string;
    startUrls?: string[];
    schedule?: string;
    [k: string]: unknown;
  };
}

export interface AlUsagePoint {
  t: number;
  v: number | Record<string, number>;
}
