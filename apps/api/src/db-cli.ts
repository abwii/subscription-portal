import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { runMigrations, runSqlFile } from "./migrate.js";

const command = process.argv[2];
const root = fileURLToPath(new URL("..", import.meta.url));
const db = createDatabase(loadConfig(process.env).databaseUrl);

try {
  if (command === "migrate") {
    const applied = await runMigrations(db, `${root}migrations`);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } else if (command === "seed") {
    await runSqlFile(db, `${root}seed/dev.sql`);
    console.log("seeded");
  } else {
    console.error("usage: db-cli <migrate|seed>");
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
