/** The Upstash objects this plugin reads, as the provider's documents describe them. */
import type { components as Developer } from "./api-types.developer.gen.js";
import type { components as QStash, paths as QStashPaths } from "./api-types.qstash.gen.js";

export type Point = Developer["schemas"]["TimeSeriesData"];

/** `customer_id` is what this read before the document's `user_email`, kept as a fallback. */
export type UpRedis = Developer["schemas"]["Database"] & { customer_id?: string };
export type UpVector = Developer["schemas"]["VectorIndex"];
export type UpSearch = Developer["schemas"]["SearchIndex"];
export type UpQStashUser = Developer["schemas"]["QStashUser"];
export type UpTeam = Developer["schemas"]["Team"];

export type UpSchedule = QStash["schemas"]["Schedule"];
export type UpQueue = QStash["schemas"]["Queue"];
export type UpUrlGroup = QStash["schemas"]["URLGroup"];

/** Something that lives under one regional QStash account. */
export interface QStashChild<V> {
  qstashId: string;
  item: V;
}

/** The calls that send the user's message as it stands, and so stay outside the client. */
export type ScheduleCreateOperation = QStashPaths["/v2/schedules/{destination}"]["post"];
export type PublishOperation = QStashPaths["/v2/publish/{destination}"]["post"];
export type EnqueueOperation = QStashPaths["/v2/enqueue/{queueName}/{destination}"]["post"];
