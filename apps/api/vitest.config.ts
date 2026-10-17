import { defineConfig } from "vitest/config";

// Les tests d'intégration SQL partagent une base (tables vidées à chaque test) : pas de fichiers en parallèle.
export default defineConfig({
  test: { environment: "node", fileParallelism: false },
});
