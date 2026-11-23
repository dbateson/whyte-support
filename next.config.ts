import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The design system ships plain CSS and fonts from node_modules.
  transpilePackages: ["@whyte/design-system"],
  poweredByHeader: false,
  // Server-only packages stay out of client bundles.
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
