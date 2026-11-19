/**
 * The one rule about where a note began: *a note keeps its origin conversation only while all of its content came from
 * that conversation.* It matters because a group's Agent is shown a note in the vault when that note began in that very
 * group ("what was said there may be used there", store.ts `notesFor`): a note that has since taken in words from anywhere
 * else must not stay shown there, or the vault would leak through the origin.
 *
 * Every path that makes a note's text out of anything but what it already says asks here what the origin is afterwards
 * (apply.ts for a review's replace, a dream's merge, rewrite and split; routes.ts for the owner's own edit). Nothing else
 * decides it. An undo puts the recorded origin back exactly (the op stores it), it does not ask.
 */

/** Where the new text of a note came from. */
export type Content =
  /** Written from one conversation (a review of it); a dream has none (`id: null`). */
  | { from: "conversation"; id: string | null }
  /** Made out of other notes (a merge): the origins of every note whose content it carries, the note's own included. */
  | { from: "notes"; origins: ReadonlyArray<string | null> }
  /** Says nothing the note did not (a split, checked to add nothing). */
  | { from: "nothing-new" }
  /** Typed by the owner, who may have written anything. */
  | { from: "owner" };

/** The origin conversation the note `origin` has once its text is `content`: the same, or null when something new has come in. */
export function keptOrigin(origin: string | null, content: Content): string | null {
  if (origin === null) return null;
  switch (content.from) {
    case "nothing-new":
      return origin;
    case "conversation":
      return content.id === origin ? origin : null;
    case "notes":
      return content.origins.every((o) => o === origin) ? origin : null;
    case "owner":
      return null;
  }
}
