/** Temps injecté : prorata, pauses, séries et expirations restent testables. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
