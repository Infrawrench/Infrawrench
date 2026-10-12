import type {
  SeatListResponse,
  SeatRemovalResponse,
  SeatSettings,
  SeatsClient,
} from "@infrawrench/ui";
import { apiGet, apiPost, apiPut } from "./api";

/** Web implementation of the Seats section's data access. */
export function createWebSeatsClient(orgId: string): SeatsClient {
  const base = `/api/org/${orgId}/seats`;
  return {
    listSeats: () => apiGet<SeatListResponse>(base),
    refreshSeats: () => apiPost<{ queued: number }>(`${base}/refresh`),
    removeSeat: (seatId) =>
      apiPost<SeatRemovalResponse>(`${base}/${encodeURIComponent(seatId)}/remove`),
    updateSeatSettings: (settings: SeatSettings) =>
      apiPut<SeatSettings>(`${base}/settings`, settings),
  };
}
