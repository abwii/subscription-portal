import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Queryable } from "./db.js";
import { runMigrations } from "./migrate.js";

function fakeDb(applied: string[]) {
  const executed: string[] = [];
  const db: Queryable = {
    query: <T extends object>(sql: string): Promise<T[]> => {
      if (sql.startsWith("SELECT name FROM schema_migrations")) {
        return Promise.resolve(applied.map((name) => ({ name })) as T[]);
      }
      executed.push(sql);
      return Promise.resolve([]);
    },
  };
  return { db, executed };
}

async function dirWith(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql);
  }
  return dir;
}

describe("runMigrations", () => {
  it("applies pending .sql files in name order and records them", async () => {
    const dir = await dirWith({
      "002_b.sql": "SELECT 2;",
      "001_a.sql": "SELECT 1;",
      "notes.txt": "ignored",
    });
    const { db, executed } = fakeDb([]);
    const applied = await runMigrations(db, dir);
    expect(applied).toEqual(["001_a.sql", "002_b.sql"]);
    const run = executed.filter((sql) => !sql.startsWith("CREATE TABLE IF"));
    expect(run).toHaveLength(2);
    expect(run[0]).toContain("SELECT 1;");
    expect(run[0]).toContain("INSERT INTO schema_migrations");
    expect(run[0]).toContain("001_a.sql");
    expect(run[1]).toContain("SELECT 2;");
  });

  it("skips migrations already applied", async () => {
    const dir = await dirWith({ "001_a.sql": "SELECT 1;" });
    const { db, executed } = fakeDb(["001_a.sql"]);
    expect(await runMigrations(db, dir)).toEqual([]);
    expect(executed.some((sql) => sql.includes("SELECT 1;"))).toBe(false);
  });
});
