import type { NextConfig } from "next";

// In local development the browser calls /api/* on the Next.js dev server, which proxies
// to the FastAPI backend. On Vercel, Services routing sends /api/* to the Python
// backend before it reaches Next.js, so no rewrite is needed there.
const BACKEND_URL = process.env.BACKEND_URL ?? (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8000" : "");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  poweredByHeader: false,
  async rewrites() {
    return BACKEND_URL ? [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }] : [];
  },
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      // KB files are embedded on the article page: framed by this site only.
      { source: "/api/files/:path*", headers: [...common, { key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      { source: "/((?!api/files/).*)", headers: [...common, { key: "X-Frame-Options", value: "DENY" }] },
    ];
  },
};

export default nextConfig;
