/**
 * The one Origin comparison, shared by the WebSocket upgrade and the state-changing-request check:
 * a browser's `Origin` header must be exactly the app's origin (scheme, host and port; no look-alike
 * suffix, other scheme, other port, `null` or list). Returns a test for `Origin` header values; a missing
 * header never matches — callers decide what absence means.
 */
export function appOriginCheck(appOrigin: string): (origin: string | undefined) => boolean {
  const expected = new URL(appOrigin).origin;
  return (origin) => origin === expected;
}
