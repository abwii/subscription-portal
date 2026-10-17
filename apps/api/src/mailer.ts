export interface GiftEmail {
  to: string;
  /** Secret porteur : à ne jamais journaliser en production. */
  code: string;
  planName: string;
  durationPeriods: number;
  expiresAt: Date;
}

/** Port d'envoi d'e-mails (fournisseur à choisir ; aucun n'est branché pour l'instant). */
export interface Mailer {
  sendGiftEmail(message: GiftEmail): Promise<void>;
}

/** Développement local uniquement : écrit le message (code compris) sur la sortie standard. */
export function createConsoleMailer(): Mailer {
  return {
    sendGiftEmail(message) {
      console.log(
        `[mail] gift for ${message.to}: ${message.planName} x${String(message.durationPeriods)}, ` +
          `code ${message.code}, valid until ${message.expiresAt.toISOString()}`,
      );
      return Promise.resolve();
    },
  };
}
