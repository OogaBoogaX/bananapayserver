// The relay's credential. The relay presents a random token as a bearer token; the Worker holds
// only its SHA-256, as a secret. The front door and the Durable Object both check it, so a line
// can't be opened by reaching the object some other way, such as another Worker binding it.

export async function relayAuthorized(request, env) {
  const expected = String(env.RELAY_TOKEN_SHA256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
  const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}
