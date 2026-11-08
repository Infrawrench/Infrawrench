/**
 * SLOs: cloud-mode only. Typed calls to the contract's `slos` domain over the
 * cloud transport (`./cloud-client.ts`), matching `cloud-probes.ts`.
 */
import type {
  Slo,
  SloActiveFreeze,
  SloDetailResponse,
  SloFreezeRequest,
  SloInput,
  SloListResponse,
  SloSourcesResponse,
} from "@infrawrench/client-core";
import { Schema } from "effect";
import { cloudClient, CloudRequestEncodeError } from "./cloud-client";
import { runRpc } from "./rpc/client";

const slos = () => cloudClient("slos").slos;

export function listCloudSlos(orgId: string): Promise<SloListResponse> {
  return runRpc(slos().list({ params: { orgId } }));
}

export function getCloudSloSources(orgId: string): Promise<SloSourcesResponse> {
  return runRpc(slos().sources({ params: { orgId } }));
}

export function getCloudSlo(orgId: string, sloId: string): Promise<SloDetailResponse> {
  return runRpc(slos().get({ params: { orgId, sloId } }));
}

export function createCloudSlo(orgId: string, input: SloInput): Promise<Slo> {
  return runRpc(slos().create({ params: { orgId }, payload: input }));
}

export function updateCloudSlo(
  orgId: string,
  sloId: string,
  patch: Partial<SloInput>,
): Promise<Slo> {
  return runRpc(slos().update({ params: { orgId, sloId }, payload: patch }));
}

export function deleteCloudSlo(orgId: string, sloId: string): Promise<void> {
  return runRpc(slos().delete({ params: { orgId, sloId } }));
}

/** The freeze lengths the endpoint takes (client-core types them as any number). */
const isFreezeDuration = Schema.is(Schema.Literals([24, 72, 168]));

export function startCloudSloFreeze(
  orgId: string,
  sloId: string,
  request: SloFreezeRequest,
): Promise<SloActiveFreeze> {
  const { durationHours } = request;
  if (durationHours !== null && !isFreezeDuration(durationHours)) {
    return Promise.reject(
      new CloudRequestEncodeError({ message: "durationHours must be one of 24, 72, 168 or null" }),
    );
  }
  const payload = {
    durationHours,
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  };
  return runRpc(slos().freeze({ params: { orgId, sloId }, payload }));
}
