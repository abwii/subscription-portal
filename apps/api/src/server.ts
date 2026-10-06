import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);
const app = await buildApp({ db });

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
