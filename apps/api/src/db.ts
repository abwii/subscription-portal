import pg from "pg";
import type { Database } from "./app.js";

export interface PgDatabase extends Database {
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): PgDatabase {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    async ping() {
      await pool.query("SELECT 1");
    },
    close: () => pool.end(),
  };
}
