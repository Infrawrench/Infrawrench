/**
 * Game-day failure actions on AWS: scale an ECS service to zero tasks, and
 * back to the desired count it had.
 *
 * `UpdateService` with only `desiredCount` changes nothing else about the
 * service (no new deployment of the task definition), so the undo restores
 * exactly what was there. The count is read with `DescribeServices` before
 * anything changes and handed back to the undo by the host. Stop/start of EC2
 * and RDS instances needs nothing here: their `lifecycle` pair already makes
 * them game-day targets.
 */
import type {
  FailureActionDeclaration,
  FailureUndoState,
  PreparedFailure,
} from "@infrawrench/plugin-base";

export const ECS_SCALE_TO_ZERO: FailureActionDeclaration = {
  id: "scale-to-zero",
  label: "Scale to zero tasks",
  undoLabel: "Scale back to the previous desired count",
  description: "ECS stops every task of the service; its load balancer targets drain.",
};

/** The one ECS call shape these need, bound to the service's region. */
export type EcsCall = <T>(target: string, body: Record<string, unknown>) => Promise<T>;

export interface EcsServiceRef {
  cluster: string;
  service: string;
}

/** `externalId` is `"<cluster>/<service>"`, as the lister writes it. */
export function ecsServiceRef(externalId: string): EcsServiceRef {
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) {
    throw new Error(`AWS plugin: cannot read the ECS cluster and service from "${externalId}"`);
  }
  return { cluster: externalId.slice(0, slash), service: externalId.slice(slash + 1) };
}

function assertAction(typeId: string, actionId: string): void {
  if (typeId !== "ecs-service" || actionId !== ECS_SCALE_TO_ZERO.id) {
    throw new Error(`AWS plugin: no failure action "${actionId}" for type "${typeId}"`);
  }
}

export async function prepareEcsFailure(
  call: EcsCall,
  ref: EcsServiceRef,
  typeId: string,
  actionId: string,
): Promise<PreparedFailure> {
  assertAction(typeId, actionId);
  const data = await call<{ services?: { desiredCount?: number; status?: string }[] }>(
    "AmazonEC2ContainerServiceV20141113.DescribeServices",
    { cluster: ref.cluster, services: [ref.service] },
  );
  const svc = data.services?.[0];
  if (!svc) throw new Error(`AWS plugin: ECS service ${ref.cluster}/${ref.service} not found`);
  const desiredCount = svc.desiredCount ?? 0;
  return {
    undo: { desiredCount },
    alreadyInEffect: desiredCount === 0,
    currentState: `${desiredCount} desired ${desiredCount === 1 ? "task" : "tasks"}`,
  };
}

async function setDesiredCount(call: EcsCall, ref: EcsServiceRef, desiredCount: number) {
  await call("AmazonEC2ContainerServiceV20141113.UpdateService", {
    cluster: ref.cluster,
    service: ref.service,
    desiredCount,
  });
}

export async function injectEcsFailure(
  call: EcsCall,
  ref: EcsServiceRef,
  typeId: string,
  actionId: string,
): Promise<void> {
  assertAction(typeId, actionId);
  await setDesiredCount(call, ref, 0);
}

export async function undoEcsFailure(
  call: EcsCall,
  ref: EcsServiceRef,
  typeId: string,
  actionId: string,
  undo: FailureUndoState,
): Promise<void> {
  assertAction(typeId, actionId);
  const desiredCount = undo["desiredCount"];
  if (typeof desiredCount !== "number" || !Number.isInteger(desiredCount) || desiredCount < 0) {
    throw new Error("AWS plugin: the stored desired count to restore is missing");
  }
  await setDesiredCount(call, ref, desiredCount);
}
