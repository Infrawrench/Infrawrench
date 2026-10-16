import { useCallback } from "react";
import { useGT } from "gt-react";
import {
  parseResourceReportColumn,
  type ResourceReportCoreField,
  type ResourceReportCostWindow,
  type ResourceReportTagFilter,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

type Gt = ReturnType<typeof useGT>;

export function coreFieldLabel(field: ResourceReportCoreField, gt: Gt): string {
  switch (field) {
    case "name":
      return gt("Name");
    case "type":
      return gt("Type");
    case "provider":
      return gt("Provider");
    case "account":
      return gt("Account");
    case "region":
      return gt("Region");
    case "status":
      return gt("Status");
    case "created":
      return gt("Created");
    case "external_id":
      return gt("Provider ID");
  }
}

export function costWindowLabel(window: ResourceReportCostWindow, gt: Gt): string {
  switch (window) {
    case "range":
      return gt("Accrued cost");
    case "mtd":
      return gt("Month to date");
    case "previous_month":
      return gt("Previous month");
  }
}

export function tagOpLabel(op: ResourceReportTagFilter["op"], gt: Gt): string {
  switch (op) {
    case "in":
      return gt("is any of");
    case "not_in":
      return gt("is none of");
    case "exists":
      return gt("is set");
    case "missing":
      return gt("is not set");
  }
}

/**
 * A translated label for any column id. Field labels come from the plugins'
 * resource type definitions, so they go through the data-string lookup the
 * plugin-strings manifest feeds; tag keys are the org's own and stay as typed.
 */
export function useColumnLabel(fieldLabels: ReadonlyMap<string, string>): (id: string) => string {
  const gt = useGT();
  const gtData = useDataString();
  return useCallback(
    (id: string) => {
      const parsed = parseResourceReportColumn(id);
      if (!parsed) return id;
      switch (parsed.kind) {
        case "core":
          return coreFieldLabel(parsed.key as ResourceReportCoreField, gt);
        case "cost":
          return costWindowLabel(parsed.key as ResourceReportCostWindow, gt);
        case "field": {
          const label = fieldLabels.get(parsed.key);
          return label ? gtData(label) : parsed.key;
        }
        case "tag":
          return gt("Tag: {key}", { key: parsed.key });
        case "vtag":
          return gt("Virtual tag: {key}", { key: parsed.key });
      }
    },
    [gt, gtData, fieldLabels],
  );
}
