import { useState } from "react";
import { Alert } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { pdfFileName, withPdfTimezone, type CloudFetch } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Download a server-rendered PDF (`/cost-reports/{id}/pdf`,
 * `/dashboards/{id}/pdf`) into the cache directory and hand it to the share
 * sheet. The rendering is the server's: this is the same document the web
 * download and the scheduled email attach, so mobile adds no renderer of its
 * own. The file is named with client-core's `pdfFileName`, the name the
 * server's Content-Disposition uses too.
 */
export async function sharePdf(
  api: CloudFetch,
  orgId: string,
  path: string,
  name: string,
): Promise<void> {
  const res = await api.raw(withPdfTimezone(`/api/org/${encodeURIComponent(orgId)}${path}`), {
    headers: { Accept: "application/pdf" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Export failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Every PDF opens with `%PDF-`. Anything else (an HTML page from a server
  // without this route) would share as a file nothing can open.
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("The server did not return a PDF. It may be running an older version.");
  }
  const file = new File(Paths.cache, pdfFileName(name));
  if (file.exists) file.delete();
  file.write(bytes);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle: name,
    });
  } else {
    Alert.alert("Saved", `Saved to ${file.uri}`);
  }
}

/**
 * `sharePdf` bound to the signed-in org, with a busy flag for the button and
 * failures reported as an alert.
 */
export function useSharePdf() {
  const { api, orgId } = useOrgApi();
  const [busy, setBusy] = useState(false);
  async function share(path: string, name: string) {
    if (busy) return;
    setBusy(true);
    try {
      await sharePdf(api, orgId, path, name);
    } catch (e) {
      Alert.alert("Couldn't export PDF", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { share, busy };
}
