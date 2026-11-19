import type { NextConfig } from "next";

// Payment pages can be served through a brand's own website (it forwards /pay/*
// here). Load JS/CSS from the portal's own domain so they never collide with
// the website's files.
const assetPrefix = process.env.NODE_ENV === "production" && process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, "") : undefined;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  assetPrefix,
  reactStrictMode: true,
  serverExternalPackages: ["postgres", "bcryptjs", "nodemailer"],
  experimental: {
    serverActions: { bodySizeLimit: "1mb" },
  },
};

export default nextConfig;
