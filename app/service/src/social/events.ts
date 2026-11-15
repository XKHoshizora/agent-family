import type { FastifyBaseLogger } from "fastify";

export type SocialListener = (principalIds: string[]) => void | Promise<void>;

/** Listeners for "this pair's social state changed"; one registry per app instance. */
export interface SocialEvents {
  on(fn: SocialListener): () => void;
  /** Call only after the transaction has committed. Never throws; listener failures are logged. */
  emit(principalIds: string[], log: Pick<FastifyBaseLogger, "error">): void;
}

export function createSocialEvents(): SocialEvents {
  const listeners = new Set<SocialListener>();
  return {
    on(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit(principalIds, log) {
      for (const fn of [...listeners]) {
        try {
          Promise.resolve(fn([...principalIds])).catch((err) => log.error({ err }, "social listener failed"));
        } catch (err) {
          log.error({ err }, "social listener failed");
        }
      }
    },
  };
}
