// GitHub sign-in, so a donation can carry its donor's GitHub handle. The Worker runs GitHub's
// sign-in, reads only the public username and numeric id, throws GitHub's token away, and keeps
// who signed in as a signed cookie on the API's own domain. Nothing here reaches a node. See
// docs/decisions/0010-handles-from-github.md.

// __Host- cookies can only be set by this host itself, over HTTPS, for the whole path, so a
// sibling subdomain can't plant one.
const SESSION = "__Host-bps_session";
const NONCE = "__Host-bps_signin";
const SESSION_SECONDS = 7 * 86_400;
const SIGNIN_SECONDS = 10 * 60;
const CALLBACK = "/auth/github/callback";

// GitHub's rule for usernames: letters, digits and single hyphens, at most 39 characters.
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const signInConfigured = (env) =>
  Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) && String(env.SESSION_KEY ?? "").length >= 32;

// GET /auth/github?return=<page>: off to GitHub, remembering where to come back to.
export async function startSignIn(request, env, platform, origins) {
  if (!signInConfigured(env)) return text("sign-in isn't set up", 503);
  const url = new URL(request.url);
  const back = returnTo(url.searchParams.get("return"), origins);
  if (!back) return text("return must be a page on an allowed origin", 400);
  const nonce = platform.id();
  const state = await seal(env.SESSION_KEY, { typ: "signin", nonce, back, exp: platform.now() + SIGNIN_SECONDS * 1000 });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", url.origin + CALLBACK);
  github.searchParams.set("state", state);
  return redirect(github, [cookie(NONCE, nonce, SIGNIN_SECONDS)]);
}

// GET /auth/github/callback: GitHub sends the donor back with a code to trade for who they are.
export async function finishSignIn(request, env, platform) {
  if (!signInConfigured(env)) return text("sign-in isn't set up", 503);
  const url = new URL(request.url);
  const state = await unseal(env.SESSION_KEY, url.searchParams.get("state"), platform.now(), "signin");
  // The nonce cookie ties the answer to the browser that asked, so nobody can sign a visitor in
  // as someone else.
  if (!state || readCookie(request, NONCE) !== state.nonce) return text("sign-in expired or didn't start here", 400);
  const clear = cookie(NONCE, "", 0);
  const code = url.searchParams.get("code");
  if (!code) return redirect(state.back, [clear]);
  const user = await githubUser(env, platform, code, url.origin + CALLBACK);
  if (!user) return text("GitHub didn't confirm who signed in", 502);
  const session = await seal(env.SESSION_KEY, { typ: "session", ...user, exp: platform.now() + SESSION_SECONDS * 1000 });
  return redirect(state.back, [clear, cookie(SESSION, session, SESSION_SECONDS)]);
}

// Who is signed in, from the session cookie, or null. A session lasts a week: signing out
// forgets it in this browser, and a renamed GitHub username shows up at the next sign-in.
export async function signedIn(request, env, platform) {
  if (!signInConfigured(env)) return null;
  const session = await unseal(env.SESSION_KEY, readCookie(request, SESSION), platform.now(), "session");
  return session && typeof session.login === "string" && LOGIN.test(session.login) &&
    Number.isSafeInteger(session.id) && session.id > 0
    ? { id: session.id, login: session.login }
    : null;
}

export const signOutCookie = () => cookie(SESSION, "", 0);

// The token is used once, to ask GitHub who this is, and never kept.
async function githubUser(env, platform, code, redirectUri) {
  const headers = { Accept: "application/json", "User-Agent": "bananapayserver" };
  try {
    const token = await (await platform.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    })).json();
    if (typeof token?.access_token !== "string") return null;
    const response = await platform.fetch("https://api.github.com/user", {
      headers: { ...headers, Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}` },
    });
    const user = response.ok ? await response.json() : null;
    return LOGIN.test(user?.login ?? "") && Number.isSafeInteger(user.id) && user.id > 0
      ? { id: user.id, login: user.login }
      : null;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();
const toBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

// A value only this Worker could have made: the payload, then its HMAC.
export async function seal(secret, payload) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return `${body}.${toBase64Url(signature)}`;
}

// The payload, if the signature holds, it's the kind expected, and it hasn't expired; otherwise
// null. The kind keeps a sign-in's state from ever passing as a session, or the other way.
export async function unseal(secret, value, now, typ) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64Url(signature), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    return payload?.typ === typ && Number.isSafeInteger(payload.exp) && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

function returnTo(value, origins) {
  try {
    const url = new URL(value);
    return origins.includes(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

// The cookie's value, or null when it's missing or there's more than one by that name, which
// only happens when something else has planted one.
function readCookie(request, name) {
  const found = [];
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) found.push(value.join("="));
  }
  return found.length === 1 ? found[0] : null;
}

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const redirect = (location, cookies) =>
  new Response(null, { status: 302, headers: [["Location", String(location)], ...cookies.map((c) => ["Set-Cookie", c])] });

const text = (body, status) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });
