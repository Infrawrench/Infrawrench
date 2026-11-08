/**
 * The object-sharing principal a request runs under, and the errors object
 * sharing throws. Split from `object-sharing.ts` so code that only carries the
 * principal or recognises the errors (the HttpApi bridge, the error renderer)
 * does not load the database layer with them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ObjectAccessLevel } from "@infrawrench/client-core";

export interface SharingPrincipal {
  organizationId: string;
  userId: string;
  roleId: string | null;
  /** Holds `sharing:override`: full access to every object. */
  override: boolean;
}

const storage = new AsyncLocalStorage<SharingPrincipal>();

export function runWithSharingPrincipal<T>(principal: SharingPrincipal, fn: () => T): T {
  return storage.run(principal, fn);
}

/**
 * The principal established for the current async context, unchecked. For the
 * Effect bridge (`http/legacy.ts`), which captures it once at a promise
 * boundary and carries it on the fiber; everything else wants the org-checked
 * lookup in `object-sharing.ts`.
 */
export function currentSharingPrincipal(): SharingPrincipal | undefined {
  return storage.getStore();
}

/** A caller below `viewer` on the object: answered as 404, never 403. */
export class ObjectNotVisibleError extends Error {
  override readonly name = "ObjectNotVisibleError";
  constructor() {
    super("Not found");
  }
}

/** A caller who can see the object but lacks the level the action needs. */
export class ObjectAccessDeniedError extends Error {
  override readonly name = "ObjectAccessDeniedError";
  constructor(
    readonly needed: ObjectAccessLevel,
    message?: string,
  ) {
    super(
      message ??
        (needed === "owner"
          ? "Only an owner of this item can do that. Ask an owner to share it with you as an owner."
          : "You can view this item but not edit it. Ask an owner to share it with you as an editor."),
    );
  }
}

export class SharingInputError extends Error {
  override readonly name = "SharingInputError";
}
