/**
 * Instance pricing warehouse tools: the MCP/chat view of
 * `GET /api/v1/instance-pricing/schema` and `POST /api/v1/instance-pricing/query`
 * (the deprecated `/api/v1/aws-pricing/*` paths serve the same handlers).
 *
 * Public provider list prices with history, not the organization's spend and
 * not the price catalog. `permission: null` mirrors `REQUIRED_PERMISSION` for
 * those routes: any authenticated caller, no scope.
 */
import { z } from "zod";
import { MAX_QUERY_ROWS } from "@infrawrench/server-core/aws-pricing-warehouse/query";
import {
  InstancePricingNotConfiguredError,
  classifyInstancePricingError,
  getInstancePricingSchema,
  instancePricingWarehouse,
  parseInstancePricingQuery,
  runInstancePricingQuery,
} from "../services/instance-pricing";
import { err, ok, type ToolDefinition } from "./types";

const NOT_CONFIGURED = "The instance pricing warehouse is not configured on this deployment";

export function instancePricingTools(): ToolDefinition[] {
  return [
    {
      name: "get_instance_pricing_schema",
      title: "Describe the instance pricing warehouse",
      description:
        "Tables, columns, types and the notes a correct query depends on for the public " +
        "instance pricing warehouse (ClickHouse), plus how fresh each source is. Call this " +
        "before query_instance_pricing when you do not already know the columns. Covers AWS " +
        "(ec2, rds, elasticache, opensearch, redshift, docdb, neptune, memorydb, dax, sagemaker, " +
        "emr, gamelift), Azure virtual machines (platform 'azure'), Google Cloud Compute Engine " +
        "('gcp'), Alibaba Cloud ECS ('alibaba') and RunPod ('runpod'), and AWS's public status " +
        "history (service_events). These are the providers' published list prices with history, " +
        "not the organization's own spend (query_costs) and not the cross-provider price " +
        "catalog (search_price_catalog, compare_instance_prices).",
      inputSchema: {},
      risk: "read",
      permission: null,
      handler: async () => {
        // Freshness is optional. The tables and notes still come back when the
        // warehouse is unconfigured or unreachable, matching GET /schema.
        return ok(await getInstancePricingSchema());
      },
    },
    {
      name: "query_instance_pricing",
      title: "Query the instance pricing warehouse",
      description:
        "Run one read-only ClickHouse statement (SELECT, WITH, DESCRIBE, SHOW or EXPLAIN) " +
        "against the public instance pricing warehouse. Same data and limits as " +
        "POST /api/v1/instance-pricing/query. Filter prices on platform and current (or a " +
        "time range on valid_from / valid_to) and compare on effective_hourly_usd; a month " +
        "is 730 hours. Usual EC2 defaults when the question does not say otherwise: " +
        "operating_system 'Linux', tenancy 'Shared', pre_installed_sw 'NA', capacity_status " +
        "'Used', license_model 'No License required', pricing 'on_demand', region 'us-east-1'. " +
        "prices has millions of EC2 rows, so aggregate or LIMIT. maxRows defaults to 1000 and " +
        "cannot exceed 10000; truncated means more rows matched. No FORMAT, SETTINGS or second " +
        "statement. A refused query or a ClickHouse error comes back as a tool error. Call " +
        "get_instance_pricing_schema for the full column list, the per-cloud defaults and how " +
        "fresh each source is. Not the organization's spend (query_costs) and not the price " +
        "catalog (search_price_catalog).",
      inputSchema: {
        sql: z
          .string()
          .describe(
            "One SELECT, WITH, DESCRIBE, SHOW or EXPLAIN statement. No FORMAT, SETTINGS or second statement.",
          ),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_QUERY_ROWS)
          .optional()
          .describe("Most rows to return. Default 1000, at most 10000."),
      },
      risk: "read",
      permission: null,
      handler: async (input) => {
        if (!instancePricingWarehouse()) return err(NOT_CONFIGURED);
        const parsed = parseInstancePricingQuery(input);
        if (!parsed.ok) return err(parsed.error);
        try {
          return ok(await runInstancePricingQuery(parsed.sql, parsed.maxRows));
        } catch (error) {
          if (error instanceof InstancePricingNotConfiguredError) return err(error.message);
          return err(classifyInstancePricingError(error).error);
        }
      },
    },
  ];
}
