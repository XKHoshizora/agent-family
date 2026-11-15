import { z } from "zod";

/** A UUID in canonical (lower-case) form: Postgres returns lower-case, so everything compared in JS must be too. */
export const uuidParam = z.uuid().transform((s) => s.toLowerCase());
