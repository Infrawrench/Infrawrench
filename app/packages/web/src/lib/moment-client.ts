import {
  momentSearchParams,
  type MomentClient,
  type MomentRequest,
  type MomentResponse,
} from "@infrawrench/ui";
import { apiGet } from "./api";

/** Web binding for the shared moment panel — a thin `apiGet` wrapper. */
export function createWebMomentClient(orgId: string): MomentClient {
  return {
    getMoment: (request: MomentRequest) => {
      const query = momentSearchParams(request);
      return apiGet<MomentResponse>(`/api/org/${orgId}/moment${query ? `?${query}` : ""}`);
    },
  };
}
