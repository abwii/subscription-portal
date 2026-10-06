import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Racine du monorepo : le build standalone y embarque les packages workspace.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // @subscription-portal/ui est publié en TypeScript source : Next le compile.
  transpilePackages: ["@subscription-portal/ui"],
};

export default config;
