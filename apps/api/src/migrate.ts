import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Queryable } from "./db.js";

/**
 * Applique les fichiers `.sql` de `dir` pas encore appliqués, dans l'ordre alphabétique.
 * Chaque fichier est envoyé en une seule requête (donc une seule transaction implicite),
 * avec l'enregistrement dans `schema_migrations`. Retourne les noms appliqués.
 */
export async function runMigrations(
  db: Queryable,
  dir: string,
): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map(
      (row) => row.name,
    ),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const name = file.replaceAll("'", "''");
    await db.query(
      `${sql}\nINSERT INTO schema_migrations (name) VALUES ('${name}');`,
    );
    applied.push(file);
  }
  return applied;
}

/** Exécute un fichier SQL idempotent (seed local). */
export async function runSqlFile(db: Queryable, file: string): Promise<void> {
  await db.query(await readFile(file, "utf8"));
}
