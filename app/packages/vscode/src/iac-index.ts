import * as vscode from "vscode";
import {
  loadIacAddressIndex,
  type IacAddressIndex,
  type IacStateSummary,
} from "@infrawrench/client-core";
import { TtlCache } from "./cache";
import type { Session } from "./session";

export interface LoadedIacIndex {
  index: IacAddressIndex;
  states: IacStateSummary[];
  failedStates: string[];
}

/**
 * The org's Terraform address index, reconciled from every uploaded state.
 * Reconciliation is the heaviest read the extension makes, so it is cached
 * for five minutes and shared by the hover and every CodeLens.
 */
export class IacIndexService implements vscode.Disposable {
  private readonly cache = new TtlCache<LoadedIacIndex>(5 * 60 * 1000);
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly session: Session) {}

  get(): Promise<LoadedIacIndex> | null {
    const api = this.session.api;
    const orgId = this.session.orgId;
    if (!api || !orgId) return null;
    return this.cache.get(orgId, () => loadIacAddressIndex(api, orgId));
  }

  refresh(): void {
    this.cache.clear();
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
