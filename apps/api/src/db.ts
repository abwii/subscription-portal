import pg from "pg";
import type { Database } from "./app.js";

/** Port de requêtes SQL paramétrées, injecté dans les dépôts. */
export interface Queryable {
  query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface PgDatabase extends Database, Queryable {
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): PgDatabase {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    async ping() {
      await pool.query("SELECT 1");
    },
    async query<T extends object>(sql: string, params?: unknown[]) {
      const result = await pool.query<T>(sql, params);
      return result.rows;
    },
    close: () => pool.end(),
  };
}
