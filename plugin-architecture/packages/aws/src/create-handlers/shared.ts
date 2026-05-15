import type {
  CreateResourceConfig,
  ResourceInstance,
  PolicyOption,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "../auth.js";

export interface AwsCreateContext {
  creds: AwsCredentials;
  hostForService(service: string): string;
  ec2<T>(action: string, params?: Record<string, string>): Promise<T>;
  json<T>(service: string, target: string, body: Record<string, unknown>): Promise<T>;
  ec2Query<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T>;
  queryPost<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T>;
  xmlGet<T>(service: string, path?: string): Promise<T>;
  makeId(accountId: string, typeId: string, externalId: string): string;
  listAllIAMPolicies(scope: "AWS" | "Local" | "All"): Promise<Array<Record<string, unknown>>>;
  policiesToOptions(raw: Array<Record<string, unknown>>, category: string): PolicyOption[];
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
  /**
   * Return a sub-context whose AWS calls are signed for and routed to the
   * given region. Create handlers should call this with the user-picked
   * `fields.region` so resources land where the form said they should.
   */
  withRegion(region: string): AwsCreateContext;
}

/**
 * Each service module exports a getConfig and a create function. They return
 * `null` when the typeId is not handled by that module, so the dispatcher can
 * try the next one. The first non-null result wins.
 */
export type GetConfigHandler = (
  ctx: AwsCreateContext,
  typeId: string,
  parentResourceId?: string,
) => Promise<CreateResourceConfig | null>;

export type CreateHandler = (
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
) => Promise<ResourceInstance | null>;
