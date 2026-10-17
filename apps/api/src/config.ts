export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  /** Authentification de développement par en-tête `X-Account-Id`. Jamais en production. */
  devAuth: boolean;
  /** Derrière un proxy de confiance (Fly) : l'IP cliente vient de X-Forwarded-For. */
  trustProxy: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const devAuth = env.DEV_AUTH === "true";
  if (devAuth && env.NODE_ENV === "production") {
    throw new Error("DEV_AUTH must not be enabled in production");
  }

  return {
    databaseUrl,
    port,
    host: env.HOST ?? "0.0.0.0",
    devAuth,
    trustProxy: env.TRUST_PROXY === "true",
  };
}
