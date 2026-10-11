import type { NextConfig } from "next";

// API-only server: every route reads the request, so nothing is prerendered.
const nextConfig: NextConfig = {};

export default nextConfig;
