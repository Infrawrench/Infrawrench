import { loadDecoded } from "@/lib/load";
import { buildRegionData, findRegion, regionInfo } from "@/lib/model";

/**
 * GET /api/aws/<platform>/<instance>/<region>: one region's full price
 * history (a `RegionData`), which an instance page fetches when the visitor
 * picks a region other than the one it was rendered with.
 */
export const revalidate = 1800;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string; instance: string; region: string }> },
) {
  const { platform, instance, region } = await params;
  const decoded = await loadDecoded(platform, decodeURIComponent(instance));
  if (!decoded) return Response.json({ error: "No such instance" }, { status: 404 });
  const index = findRegion(regionInfo(decoded.regions), decodeURIComponent(region));
  if (index < 0) return Response.json({ error: "No such region" }, { status: 404 });
  return Response.json(buildRegionData(decoded, index), {
    headers: { "cache-control": "public, max-age=300, stale-while-revalidate=86400" },
  });
}
