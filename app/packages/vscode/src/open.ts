import * as vscode from "vscode";
import {
  desktopDeepLink,
  webObjectUrl,
  webResourceUrl,
  webServiceUrl,
  webVulnerabilitiesUrl,
  type DeepLinkResource,
  type SearchObjectKind,
} from "@infrawrench/client-core";
import { readConfig } from "./config";
import type { Session } from "./session";

/** Arguments of `infrawrench.openResource` (also used by hover links). */
export type OpenResourceArgs = DeepLinkResource;

export async function openResource(session: Session, r: OpenResourceArgs): Promise<void> {
  const orgId = session.orgId;
  if (!orgId) return;
  const target =
    readConfig().openIn === "desktop"
      ? desktopDeepLink({ kind: "resource", orgId, ...r })
      : webResourceUrl(session.cloudUrl, orgId, r);
  await vscode.env.openExternal(vscode.Uri.parse(target, true));
}

export async function openService(session: Session, serviceId: string): Promise<void> {
  const orgId = session.orgId;
  if (!orgId) return;
  const target =
    readConfig().openIn === "desktop"
      ? desktopDeepLink({ kind: "service", orgId, serviceId })
      : webServiceUrl(session.cloudUrl, orgId, serviceId);
  await vscode.env.openExternal(vscode.Uri.parse(target, true));
}

export async function openVulnerabilities(session: Session): Promise<void> {
  const orgId = session.orgId;
  if (!orgId) return;
  const target =
    readConfig().openIn === "desktop"
      ? desktopDeepLink({ kind: "vulnerabilities", orgId })
      : webVulnerabilitiesUrl(session.cloudUrl, orgId);
  await vscode.env.openExternal(vscode.Uri.parse(target, true));
}

/** A saved object from the search index (report, dashboard, SLO, …). */
export async function openObject(
  session: Session,
  objectKind: SearchObjectKind,
  objectId: string,
): Promise<void> {
  const orgId = session.orgId;
  if (!orgId) return;
  const target =
    readConfig().openIn === "desktop"
      ? desktopDeepLink({ kind: "object", orgId, objectKind, objectId })
      : webObjectUrl(session.cloudUrl, orgId, objectKind, objectId);
  await vscode.env.openExternal(vscode.Uri.parse(target, true));
}

export async function openUrl(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url, true));
}
