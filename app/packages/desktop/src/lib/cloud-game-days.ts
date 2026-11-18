/**
 * Game days: cloud-mode only. Typed calls to the contract's `gameDays` domain
 * over the cloud transport (`./cloud-client.ts`), matching `cloud-slos.ts`.
 */
import type {
  GameDay,
  GameDayCandidates,
  GameDayDetail,
  GameDayInput,
  GameDayList,
  GameDayPlan,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const gameDays = () => cloudClient("gameDays").gameDays;

export function listCloudGameDays(orgId: string): Promise<GameDayList> {
  return runRpc(gameDays().list({ params: { orgId } }));
}

export function getCloudGameDay(orgId: string, gameDayId: string): Promise<GameDayDetail> {
  return runRpc(gameDays().get({ params: { orgId, gameDayId } }));
}

export function getCloudGameDayCandidates(orgId: string): Promise<GameDayCandidates> {
  return runRpc(gameDays().candidates({ params: { orgId } }));
}

export function planCloudGameDay(orgId: string, input: GameDayInput): Promise<GameDayPlan> {
  return runRpc(gameDays().plan({ params: { orgId }, payload: input }));
}

export function createCloudGameDay(orgId: string, input: GameDayInput): Promise<GameDay> {
  return runRpc(gameDays().create({ params: { orgId }, payload: input }));
}

export function updateCloudGameDay(
  orgId: string,
  gameDayId: string,
  input: GameDayInput,
): Promise<GameDay> {
  return runRpc(gameDays().update({ params: { orgId, gameDayId }, payload: input }));
}

export async function deleteCloudGameDay(orgId: string, gameDayId: string): Promise<void> {
  await runRpc(gameDays().delete({ params: { orgId, gameDayId } }));
}

export function armCloudGameDay(
  orgId: string,
  gameDayId: string,
  confirmName: string,
): Promise<GameDay> {
  return runRpc(gameDays().arm({ params: { orgId, gameDayId }, payload: { confirmName } }));
}

export function disarmCloudGameDay(orgId: string, gameDayId: string): Promise<GameDay> {
  return runRpc(gameDays().disarm({ params: { orgId, gameDayId } }));
}

export function endCloudGameDay(orgId: string, gameDayId: string): Promise<GameDay> {
  return runRpc(gameDays().end({ params: { orgId, gameDayId } }));
}

export function abortCloudGameDay(orgId: string, gameDayId: string): Promise<GameDay> {
  return runRpc(gameDays().abort({ params: { orgId, gameDayId } }));
}

export function retryCloudGameDayUndo(orgId: string, gameDayId: string): Promise<GameDay> {
  return runRpc(gameDays().retryUndo({ params: { orgId, gameDayId } }));
}
