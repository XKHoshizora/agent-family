import { z } from "zod";

/** A model as a request names it (`providerId` is normalised to lower case), and as a response shows it. */
export const chosenModel = (providerId: z.ZodType<string>) =>
  z.union([
    z.strictObject({ source: z.literal("site"), id: z.string().min(1).max(64) }),
    z.strictObject({ source: z.literal("provider"), providerId, model: z.string().min(1).max(200) }),
  ]);
