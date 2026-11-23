import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The design system ships plain CSS and fonts from node_modules.
  transpilePackages: ["@whyte/design-system"],
  poweredByHeader: false,
  // Server-only packages stay out of client bundles.
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      {
        // The embeddable widgets and their fonts load on whytebikes.com.
        source: "/embed/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=86400" },
        ],
      },
      {
        source: "/((?!embed/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
};

export default nextConfig;
