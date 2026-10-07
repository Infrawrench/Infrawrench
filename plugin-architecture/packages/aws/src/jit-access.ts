/**
 * Just-in-time access for AWS, through IAM Identity Center account
 * assignments: "give this Identity Center user this permission set on this
 * AWS account", and take it away again.
 *
 * Why account assignments and not attaching policies to IAM users or editing
 * role trust: an assignment is the unit AWS itself offers for "who may sign
 * in to which account as what", it is visible in the access portal the user
 * already signs in through, and removing it ends the user's ability to start
 * new sessions there. Editing trust policies would mean rewriting a document
 * other tooling also owns, and attaching policies to IAM users assumes the
 * organization still hands out long-lived IAM users at all.
 *
 * **Wire shapes verified against live AWS documentation, October 2026:**
 * - IAM Identity Center admin API ("sso-admin", 2020-07-20): AWS JSON 1.1 over
 *   `POST https://sso.<region>.amazonaws.com/`, `X-Amz-Target:
 *   SWBExternalService.<Op>`, SigV4 signing name `sso`.
 *   - `ListInstances` -> `Instances[]{InstanceArn, IdentityStoreId, Status}`
 *   - `ListPermissionSets{InstanceArn}` -> `PermissionSets[]` (ARNs)
 *   - `DescribePermissionSet{InstanceArn, PermissionSetArn}` ->
 *     `PermissionSet{Name, Description, SessionDuration}`
 *   - `ListAccountAssignments{InstanceArn, AccountId, PermissionSetArn}` ->
 *     `AccountAssignments[]{AccountId, PermissionSetArn, PrincipalId, PrincipalType}`
 *   - `CreateAccountAssignment` / `DeleteAccountAssignment{InstanceArn,
 *     TargetId, TargetType: "AWS_ACCOUNT", PermissionSetArn, PrincipalType,
 *     PrincipalId}` -> `AccountAssignment{Creation,Deletion}Status{RequestId,
 *     Status: IN_PROGRESS|FAILED|SUCCEEDED, FailureReason}`; both are
 *     asynchronous, polled with `DescribeAccountAssignment{Creation,Deletion}Status
 *     {InstanceArn, <Op>RequestId}`.
 * - Identity Store (2020-06-15): AWS JSON 1.1 over
 *   `POST https://identitystore.<region>.amazonaws.com/`, `X-Amz-Target:
 *   AWSIdentityStore.<Op>`, signing name `identitystore`.
 *   - `GetUserId{IdentityStoreId, AlternateIdentifier: {UniqueAttribute:
 *     {AttributePath: "emails.value", AttributeValue}}}` -> `UserId`
 *   - `DescribeUser{IdentityStoreId, UserId}` / `ListUsers{IdentityStoreId}`
 *     -> `UserName`, `DisplayName`, `Emails[]{Value, Primary}`
 * - Organizations: `AWSOrganizationsV20161128.ListAccounts` on
 *   `organizations.us-east-1.amazonaws.com`, signing region `us-east-1`.
 *
 * An assignment is a bare tuple with no name, so a JIT assignment cannot be
 * told apart from a standing one. That is why `checkJitAccess` exists and the
 * host calls it before granting: if the user already holds the permission set
 * on that account, nothing is created, and nothing is removed at expiry.
 */

import type {
  JitAccessDeclaration,
  JitAccessPresence,
  JitGrantResult,
  JitGrantSpec,
  JitIdentity,
  JitPrincipal,
  JitRole,
  JitScope,
} from "@infrawrench/plugin-base";

export const AWS_JIT_ACCESS: JitAccessDeclaration = {
  scopeLabel: "AWS account",
  roleLabel: "Permission set",
  principalLabel: "Identity Center user",
  description:
    "Assigns the permission set to the user on that account in IAM Identity Center, and removes " +
    "the assignment when the window ends. Connect the organization's management account or a " +
    "delegated administrator for IAM Identity Center.",
  providerEnforcedExpiry: false,
  principalPicker: true,
};

/** The SigV4 JSON 1.1 call the client hands in, so this module stays testable. */
export interface AwsJitContext {
  /** POST one JSON 1.1 operation to `https://<host>/`, signed as `service` in `region`. */
  call<T>(args: {
    host: string;
    service: string;
    region: string;
    target: string;
    body: Record<string, unknown>;
  }): Promise<T>;
  /** The credential's home region, tried first for the Identity Center instance. */
  homeRegion: string;
  /** Every region enabled on the account, for finding the instance elsewhere. */
  regions(): Promise<string[]>;
  /** The connected account's own id, for orgs where Organizations is not readable. */
  callerAccountId(): Promise<string>;
  /** Wait between status polls. Injected so tests do not sleep. */
  sleep?(ms: number): Promise<void>;
}

interface IdentityCenterInstance {
  instanceArn: string;
  identityStoreId: string;
  region: string;
}

const instanceCache = new WeakMap<AwsJitContext, Promise<IdentityCenterInstance>>();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return /ResourceNotFoundException/.test(errorText(err));
}

function ssoCall<T>(ctx: AwsJitContext, region: string, op: string, body: Record<string, unknown>) {
  return ctx.call<T>({
    host: `sso.${region}.amazonaws.com`,
    service: "sso",
    region,
    target: `SWBExternalService.${op}`,
    body,
  });
}

function identityStoreCall<T>(
  ctx: AwsJitContext,
  region: string,
  op: string,
  body: Record<string, unknown>,
) {
  return ctx.call<T>({
    host: `identitystore.${region}.amazonaws.com`,
    service: "identitystore",
    region,
    target: `AWSIdentityStore.${op}`,
    body,
  });
}

interface ListInstancesResponse {
  Instances?: Array<{ InstanceArn?: string; IdentityStoreId?: string; Status?: string }>;
}

/**
 * Find the organization's IAM Identity Center instance.
 *
 * An instance lives in exactly one region, and nothing in the API says which,
 * so the credential's home region is asked first and then every other enabled
 * region in parallel. The user never has to know where Identity Center was
 * turned on years ago.
 */
export function findIdentityCenterInstance(ctx: AwsJitContext): Promise<IdentityCenterInstance> {
  const cached = instanceCache.get(ctx);
  if (cached) return cached;
  const promise = (async () => {
    const probe = async (region: string): Promise<IdentityCenterInstance | null> => {
      try {
        const res = await ssoCall<ListInstancesResponse>(ctx, region, "ListInstances", {});
        const active = (res.Instances ?? []).find(
          (i) => i.InstanceArn && i.IdentityStoreId && (i.Status ?? "ACTIVE") === "ACTIVE",
        );
        return active
          ? { instanceArn: active.InstanceArn!, identityStoreId: active.IdentityStoreId!, region }
          : null;
      } catch {
        return null;
      }
    };
    const home = await probe(ctx.homeRegion);
    if (home) return home;
    const others = (await ctx.regions()).filter((r) => r !== ctx.homeRegion);
    const found = (await Promise.all(others.map(probe))).find((x) => x !== null);
    if (found) return found;
    throw new Error(
      "No IAM Identity Center instance is visible to these credentials. Just-in-time access on " +
        "AWS assigns permission sets through IAM Identity Center: connect the organization's " +
        "management account or a delegated administrator, with sso:ListInstances allowed.",
    );
  })();
  instanceCache.set(ctx, promise);
  promise.catch(() => instanceCache.delete(ctx));
  return promise;
}

interface ListAccountsResponse {
  Accounts?: Array<{ Id?: string; Name?: string; Email?: string; Status?: string; State?: string }>;
  NextToken?: string;
}

export async function listAwsJitScopes(ctx: AwsJitContext): Promise<JitScope[]> {
  try {
    const scopes: JitScope[] = [];
    let next: string | undefined;
    do {
      const res = await ctx.call<ListAccountsResponse>({
        host: "organizations.us-east-1.amazonaws.com",
        service: "organizations",
        region: "us-east-1",
        target: "AWSOrganizationsV20161128.ListAccounts",
        body: next ? { NextToken: next } : {},
      });
      for (const a of res.Accounts ?? []) {
        if (!a.Id) continue;
        // `State` replaced `Status` in 2025; either saying suspended or closed
        // means nobody can sign in there, so it is not worth offering.
        const state = (a.State ?? a.Status ?? "ACTIVE").toUpperCase();
        if (state !== "ACTIVE") continue;
        scopes.push({ id: a.Id, name: a.Name || a.Id, description: a.Id });
      }
      next = res.NextToken || undefined;
    } while (next && scopes.length < 5000);
    return scopes.sort((x, y) => x.name.localeCompare(y.name));
  } catch (err) {
    // A delegated administrator without organizations:ListAccounts, or a
    // standalone account: the connected account is still a valid target.
    const id = await ctx.callerAccountId();
    if (!id) throw err;
    return [{ id, name: id, description: "This account" }];
  }
}

interface ListPermissionSetsResponse {
  PermissionSets?: string[];
  NextToken?: string;
}

interface DescribePermissionSetResponse {
  PermissionSet?: { Name?: string; Description?: string; PermissionSetArn?: string };
}

const PRIVILEGED_NAME = /admin|poweruser|fullaccess/i;

export async function listAwsJitRoles(ctx: AwsJitContext, _scopeId: string): Promise<JitRole[]> {
  const instance = await findIdentityCenterInstance(ctx);
  const arns: string[] = [];
  let next: string | undefined;
  do {
    const res = await ssoCall<ListPermissionSetsResponse>(
      ctx,
      instance.region,
      "ListPermissionSets",
      { InstanceArn: instance.instanceArn, MaxResults: 100, ...(next ? { NextToken: next } : {}) },
    );
    arns.push(...(res.PermissionSets ?? []));
    next = res.NextToken || undefined;
  } while (next && arns.length < 3500);

  // DescribePermissionSet is per ARN; a handful in flight at once keeps a
  // picker with 200 permission sets fast without tripping the throttle.
  const roles: JitRole[] = [];
  for (let i = 0; i < arns.length; i += 8) {
    const batch = arns.slice(i, i + 8);
    const described = await Promise.all(
      batch.map(async (arn) => {
        try {
          const res = await ssoCall<DescribePermissionSetResponse>(
            ctx,
            instance.region,
            "DescribePermissionSet",
            { InstanceArn: instance.instanceArn, PermissionSetArn: arn },
          );
          const name = res.PermissionSet?.Name || arn.split("/").pop() || arn;
          return {
            id: arn,
            name,
            ...(res.PermissionSet?.Description
              ? { description: res.PermissionSet.Description }
              : {}),
            privileged: PRIVILEGED_NAME.test(name),
          } satisfies JitRole;
        } catch {
          const name = arn.split("/").pop() || arn;
          return { id: arn, name } satisfies JitRole;
        }
      }),
    );
    roles.push(...described);
  }
  return roles.sort((a, b) => a.name.localeCompare(b.name));
}

interface IdentityStoreUser {
  UserId?: string;
  UserName?: string;
  DisplayName?: string;
  Emails?: Array<{ Value?: string; Primary?: boolean }>;
}

function toPrincipal(user: IdentityStoreUser): JitPrincipal | null {
  if (!user.UserId) return null;
  const email =
    user.Emails?.find((e) => e.Primary)?.Value ?? user.Emails?.[0]?.Value ?? user.UserName ?? null;
  return {
    id: user.UserId,
    name: user.DisplayName || user.UserName || email || user.UserId,
    kind: "user",
    email: email ?? null,
  };
}

export async function resolveAwsJitPrincipal(
  ctx: AwsJitContext,
  identity: JitIdentity,
): Promise<JitPrincipal | null> {
  const instance = await findIdentityCenterInstance(ctx);
  const email = identity.email.trim();
  if (!email) return null;
  // Most directories key users by email in both places; try the email
  // attribute first and the user name second, which is what a SCIM-provisioned
  // directory with `userName = email` has.
  for (const path of ["emails.value", "userName"]) {
    try {
      const res = await identityStoreCall<{ UserId?: string }>(ctx, instance.region, "GetUserId", {
        IdentityStoreId: instance.identityStoreId,
        AlternateIdentifier: { UniqueAttribute: { AttributePath: path, AttributeValue: email } },
      });
      if (!res.UserId) continue;
      try {
        const user = await identityStoreCall<IdentityStoreUser>(
          ctx,
          instance.region,
          "DescribeUser",
          { IdentityStoreId: instance.identityStoreId, UserId: res.UserId },
        );
        return toPrincipal({ ...user, UserId: res.UserId });
      } catch {
        return { id: res.UserId, name: identity.name || email, kind: "user", email };
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

export async function listAwsJitPrincipals(
  ctx: AwsJitContext,
  query?: string,
): Promise<JitPrincipal[]> {
  const instance = await findIdentityCenterInstance(ctx);
  const needle = query?.trim().toLowerCase() ?? "";
  const out: JitPrincipal[] = [];
  let next: string | undefined;
  let pages = 0;
  do {
    const res = await identityStoreCall<{ Users?: IdentityStoreUser[]; NextToken?: string }>(
      ctx,
      instance.region,
      "ListUsers",
      {
        IdentityStoreId: instance.identityStoreId,
        MaxResults: 100,
        ...(next ? { NextToken: next } : {}),
      },
    );
    for (const u of res.Users ?? []) {
      const p = toPrincipal(u);
      if (!p) continue;
      if (
        needle &&
        !p.name.toLowerCase().includes(needle) &&
        !(p.email ?? "").toLowerCase().includes(needle)
      ) {
        continue;
      }
      out.push(p);
    }
    next = res.NextToken || undefined;
    pages++;
  } while (next && pages < 20 && out.length < 200);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface ListAccountAssignmentsResponse {
  AccountAssignments?: Array<{ PrincipalId?: string; PrincipalType?: string }>;
  NextToken?: string;
}

function principalType(spec: JitGrantSpec): "USER" | "GROUP" {
  return spec.principal.kind === "group" ? "GROUP" : "USER";
}

export async function checkAwsJitAccess(
  ctx: AwsJitContext,
  spec: JitGrantSpec,
): Promise<JitAccessPresence> {
  const instance = await findIdentityCenterInstance(ctx);
  let next: string | undefined;
  do {
    const res = await ssoCall<ListAccountAssignmentsResponse>(
      ctx,
      instance.region,
      "ListAccountAssignments",
      {
        InstanceArn: instance.instanceArn,
        AccountId: spec.scopeId,
        PermissionSetArn: spec.roleId,
        MaxResults: 100,
        ...(next ? { NextToken: next } : {}),
      },
    );
    const type = principalType(spec);
    if (
      (res.AccountAssignments ?? []).some(
        (a) => a.PrincipalId === spec.principal.id && a.PrincipalType === type,
      )
    ) {
      return "present";
    }
    next = res.NextToken || undefined;
  } while (next);
  return "absent";
}

interface AssignmentStatus {
  RequestId?: string;
  Status?: string;
  FailureReason?: string;
}

/**
 * Poll an asynchronous assignment operation to completion. AWS typically
 * settles these in a few seconds; a minute is generous, and an operation still
 * in progress after that is reported as an error so the host retries rather
 * than recording success it has not seen.
 */
async function awaitAssignment(
  ctx: AwsJitContext,
  instance: IdentityCenterInstance,
  kind: "Creation" | "Deletion",
  initial: AssignmentStatus | undefined,
): Promise<AssignmentStatus> {
  let status = initial ?? {};
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 40 && status.Status === "IN_PROGRESS"; attempt++) {
    await sleep(1500);
    const res = await ssoCall<Record<string, AssignmentStatus | undefined>>(
      ctx,
      instance.region,
      `DescribeAccountAssignment${kind}Status`,
      {
        InstanceArn: instance.instanceArn,
        [`AccountAssignment${kind}RequestId`]: status.RequestId,
      },
    );
    status = res[`AccountAssignment${kind}Status`] ?? status;
  }
  if (status.Status === "FAILED") {
    throw new Error(
      `IAM Identity Center could not ${kind === "Creation" ? "create" : "remove"} the ` +
        `assignment: ${status.FailureReason ?? "no reason given"}`,
    );
  }
  if (status.Status === "IN_PROGRESS") {
    throw new Error(
      `IAM Identity Center is still ${kind === "Creation" ? "creating" : "removing"} the ` +
        `assignment (request ${status.RequestId ?? "unknown"}); it will be checked again.`,
    );
  }
  return status;
}

function assignmentBody(instance: IdentityCenterInstance, spec: JitGrantSpec) {
  return {
    InstanceArn: instance.instanceArn,
    TargetId: spec.scopeId,
    TargetType: "AWS_ACCOUNT",
    PermissionSetArn: spec.roleId,
    PrincipalType: principalType(spec),
    PrincipalId: spec.principal.id,
  };
}

export async function grantAwsJitAccess(
  ctx: AwsJitContext,
  spec: JitGrantSpec,
): Promise<JitGrantResult> {
  const instance = await findIdentityCenterInstance(ctx);
  // Idempotent by construction: if the assignment is already there (a retry
  // after the first call succeeded) there is nothing to create.
  if ((await checkAwsJitAccess(ctx, spec)) === "present") return { ref: null };
  const res = await ssoCall<{ AccountAssignmentCreationStatus?: AssignmentStatus }>(
    ctx,
    instance.region,
    "CreateAccountAssignment",
    assignmentBody(instance, spec),
  );
  const status = await awaitAssignment(
    ctx,
    instance,
    "Creation",
    res.AccountAssignmentCreationStatus,
  );
  return { ref: status.RequestId ?? null };
}

export async function revokeAwsJitAccess(ctx: AwsJitContext, spec: JitGrantSpec): Promise<void> {
  const instance = await findIdentityCenterInstance(ctx);
  // Already gone (never created, removed by hand, or a previous revoke that
  // succeeded upstream but was not recorded): success.
  if ((await checkAwsJitAccess(ctx, spec)) === "absent") return;
  let res: { AccountAssignmentDeletionStatus?: AssignmentStatus };
  try {
    res = await ssoCall(
      ctx,
      instance.region,
      "DeleteAccountAssignment",
      assignmentBody(instance, spec),
    );
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  await awaitAssignment(ctx, instance, "Deletion", res.AccountAssignmentDeletionStatus);
}
