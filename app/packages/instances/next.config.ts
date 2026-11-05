import type { NextConfig } from "next";
import { EMBED_FRAME_ANCESTORS } from "./lib/embed";

const nextConfig: NextConfig = {
  headers: async () => [
    {
      source: "/embed/:path*",
      headers: [{ key: "Content-Security-Policy", value: EMBED_FRAME_ANCESTORS }],
    },
  ],
};

export default nextConfig;
