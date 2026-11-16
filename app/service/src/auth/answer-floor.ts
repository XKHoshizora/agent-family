import { randomInt } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * How long, at least, an answer that must not tell whether an e-mail has an account takes: the generic success of
 * a registration and of a password-reset request. Their work differs with the e-mail (a lookup that finds nothing,
 * or a mail written; a new account, or a notice to an existing one); padded to the floor, it takes the same time.
 * Work that takes longer than the floor is not padded further.
 *
 * The floor is counted from the moment the whole body is in (`startAnswerClock`), not from the request's head: a
 * client that sends the head, waits, and then sends the body would otherwise have used the floor up by waiting.
 */
export interface AnswerFloor {
  ms: number;
  /** Up to this many milliseconds more, at random, so the floor itself is not one exact number. */
  jitterMs: number;
}

/** The floor outside tests (the test harness shortens it through `BuildOptions.answerFloor`). */
export const ANSWER_FLOOR: AnswerFloor = { ms: 400, jitterMs: 50 };

const clocks = new WeakMap<FastifyRequest, number>();

/** A hook that runs once the body has been parsed (`preValidation` / `preHandler`): the floor is counted from here. */
export async function startAnswerClock(req: FastifyRequest): Promise<void> {
  clocks.set(req, performance.now());
}

/** Resolves once `floor` (plus jitter) has passed since `startAnswerClock`; at once if it already has. */
export async function holdUntilFloor(req: FastifyRequest, floor: AnswerFloor): Promise<void> {
  const target = floor.ms + (floor.jitterMs > 0 ? randomInt(floor.jitterMs + 1) : 0);
  const waited = performance.now() - (clocks.get(req) ?? performance.now());
  const rest = target - waited;
  if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
}
