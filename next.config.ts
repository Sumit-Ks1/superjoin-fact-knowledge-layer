import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf ships a serverless PDF.js build; keep it (and the pg driver) out of
  // the bundler so their dynamic requires resolve at runtime on Vercel.
  serverExternalPackages: ["unpdf", "postgres"],

  experimental: {
    // Large parsed-page payloads move through Server Actions during debug flows.
    serverActions: { bodySizeLimit: "4mb" },
  },

  typescript: {
    // Type errors must fail the build. Never relax this.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
