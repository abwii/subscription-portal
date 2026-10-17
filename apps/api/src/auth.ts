import type { Authenticate } from "./catalog.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authentification provisoire : le fournisseur d'identité n'est pas encore choisi (ADR-001,
 * question ouverte 5). Sans `devAuth`, tout est refusé.
 */
export function createAuthenticate({
  devAuth,
}: {
  devAuth: boolean;
}): Authenticate {
  return (req) => {
    if (!devAuth) return Promise.resolve(null);
    const header = req.headers["x-account-id"];
    return Promise.resolve(
      typeof header === "string" && UUID.test(header) ? header : null,
    );
  };
}
