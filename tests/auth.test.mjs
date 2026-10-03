// GitHub sign-in through the Worker: the round trip to GitHub, the session cookie, and what a
// donation carries because of it.

import assert from "node:assert/strict";
import test from "node:test";
import { seal, unseal } from "../worker/auth.mjs";
import { handle } from "../worker/front.mjs";
import { fakePlatform } from "./helpers/cloudflare.mjs";
import { INVOICE } from "./helpers/values.mjs";
import { ORIGIN, post, sessionCookie, SIGN_IN, world } from "./helpers/world.mjs";

const API = "https://api.example.org";
const BACK = `${ORIGIN}/#/lightning`;
const ENV = { ...SIGN_IN, ALLOWED_ORIGINS: ORIGIN };

// GitHub, as far as sign-in sees it: a token for the code, then who the token belongs to.
function github(platform, { user = { login: "ooga-dev", id: 4242 }, token = "gho_synthetic" } = {}) {
  const calls = [];
  platform.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://github.com/login/oauth/access_token") return Response.json(token ? { access_token: token } : { error: "bad_verification_code" });
    if (String(url) === "https://api.github.com/user") return Response.json(user);
    return new Response("unexpected", { status: 500 });
  };
  return calls;
}

const cookiesOf = (response) => response.headers.getSetCookie();
const cookieValue = (response, name) => cookiesOf(response).find((c) => c.startsWith(`${name}=`))?.split(";")[0];

async function start(platform, env = ENV, back = BACK) {
  const response = await handle(new Request(`${API}/auth/github?return=${encodeURIComponent(back)}`), env, platform);
  return { response, location: response.headers.get("Location") && new URL(response.headers.get("Location")) };
}

async function finish(platform, started, query, cookie = cookieValue(started.response, "__Host-bps_signin")) {
  const state = started.location.searchParams.get("state");
  const url = `${API}/auth/github/callback?${new URLSearchParams({ state, ...query })}`;
  return handle(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }), ENV, platform);
}

test("signing in starts at GitHub, with a nonce cookie that ties the answer to this browser", async () => {
  const platform = fakePlatform();
  const { response, location } = await start(platform);
  assert.equal(response.status, 302);
  assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "synthetic-client-id");
  assert.equal(location.searchParams.get("redirect_uri"), `${API}/auth/github/callback`);
  const [nonce] = cookiesOf(response);
  assert.match(nonce, /^__Host-bps_signin=[0-9a-f]{32}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
});

test("it only ever sends the donor back to an allowed page", async () => {
  const platform = fakePlatform();
  for (const back of ["https://elsewhere.example/", "javascript:alert(1)", ""]) {
    assert.equal((await start(platform, ENV, back)).response.status, 400, back);
  }
  const unset = await start(platform, { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(unset.response.status, 503, "without the GitHub app's settings, sign-in is off");
});

test("GitHub's answer becomes a session cookie, and the token is used once and dropped", async () => {
  const platform = fakePlatform();
  const calls = github(platform);
  const started = await start(platform);
  const response = await finish(platform, started, { code: "synthetic-code" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), BACK);
  const exchange = JSON.parse(calls[0].init.body);
  assert.deepEqual(exchange, {
    client_id: "synthetic-client-id",
    client_secret: "synthetic-client-secret",
    code: "synthetic-code",
    redirect_uri: `${API}/auth/github/callback`,
  });
  assert.equal(calls[1].init.headers.Authorization, "Bearer gho_synthetic");
  assert.equal(calls.length, 2);
  const session = cookiesOf(response).find((c) => c.startsWith("__Host-bps_session="));
  assert.match(session, /; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/, "a week");
  assert.ok(!session.includes("gho_synthetic"), "the GitHub token isn't kept");
  assert.ok(cookiesOf(response).some((c) => c.startsWith("__Host-bps_signin=;") && c.includes("Max-Age=0")));
  const value = session.split(";")[0].slice("__Host-bps_session=".length);
  const payload = await unseal(SIGN_IN.SESSION_KEY, value, platform.now(), "session");
  assert.equal(payload.login, "ooga-dev");
  assert.equal(payload.id, 4242);
});

test("an answer meant for another browser, or a stale one, signs nobody in", async () => {
  const platform = fakePlatform();
  github(platform);
  const started = await start(platform);
  assert.equal((await finish(platform, started, { code: "c" }, "")).status, 400, "no nonce cookie");
  assert.equal((await finish(platform, started, { code: "c" }, `__Host-bps_signin=${"0".repeat(32)}`)).status, 400, "someone else's nonce");
  const nonce = cookieValue(started.response, "__Host-bps_signin");
  assert.equal((await finish(platform, started, { code: "c" }, `${nonce}; __Host-bps_signin=${"0".repeat(32)}`)).status, 400, "a planted second nonce");
  platform.advance(11 * 60_000);
  assert.equal((await finish(platform, started, { code: "c" })).status, 400, "after ten minutes");
});

test("a donor who says no at GitHub goes back unsigned, and a bad answer from GitHub is an error", async () => {
  const platform = fakePlatform();
  github(platform);
  const started = await start(platform);
  const declined = await finish(platform, started, { error: "access_denied" });
  assert.equal(declined.status, 302);
  assert.ok(!cookiesOf(declined).some((c) => c.startsWith("__Host-bps_session=")));

  github(platform, { token: null });
  assert.equal((await finish(platform, await start(platform), { code: "c" })).status, 502);
  github(platform, { user: { login: "not a login!", id: 1 } });
  assert.equal((await finish(platform, await start(platform), { code: "c" })).status, 502);
});

test("the page can ask who it's donating as, and sign out", async () => {
  const w = await world();
  const me = (cookie) => w.send(new Request(`${API}/auth/me`, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } }));
  const signedIn = await me(await sessionCookie(w, "ooga-dev"));
  assert.equal(signedIn.status, 200);
  assert.deepEqual(await signedIn.json(), { login: "ooga-dev" });
  assert.equal(signedIn.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal((await me()).status, 401);
  const forged = `__Host-bps_session=${await seal("another-key-another-key-another-key", { typ: "session", id: 1, login: "someone", exp: w.platform.now() + 1e6 })}`;
  assert.equal((await me(forged)).status, 401);
  const expired = `__Host-bps_session=${await seal(SIGN_IN.SESSION_KEY, { typ: "session", id: 1, login: "someone", exp: w.platform.now() - 1 })}`;
  assert.equal((await me(expired)).status, 401);
  const state = `__Host-bps_session=${await seal(SIGN_IN.SESSION_KEY, { typ: "signin", nonce: "n", back: ORIGIN, exp: w.platform.now() + 1e6 })}`;
  assert.equal((await me(state)).status, 401, "a sign-in's state never passes as a session");
  const own = await sessionCookie(w, "ooga-dev");
  const planted = await sessionCookie(w, "someone-else", 99);
  assert.equal((await me(`${own}; ${planted}`)).status, 401, "two session cookies mean something planted one");
  const out = await w.send(post("/auth/signout", ""));
  assert.equal(out.status, 204);
  assert.match(out.headers.get("Set-Cookie"), /^__Host-bps_session=; Path=\/; Max-Age=0/);
});

test("a signed-in donation carries the GitHub login, unless the donor gives anonymously", async () => {
  for (const [anon, handle, githubId] of [[false, "ooga-dev", 4242], [true, "", null]]) {
    const w = await world();
    const relay = await w.connectRelay();
    const page = await w.connectPage();
    await w.invoice(relay, { sats: 1000, anon }, undefined, { cookie: await sessionCookie(w, "ooga-dev", 4242) });
    await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
    const [{ donation }] = page.messages().filter((m) => m.type === "donation");
    assert.equal(donation.handle, handle);
    assert.equal(w.env.DB.db.prepare("SELECT github_id FROM donations").get().github_id, githubId);
  }
});

test("a cookie that doesn't check out makes the donation anonymous, not an error", async () => {
  const w = await world();
  const relay = await w.connectRelay();
  const page = await w.connectPage();
  const forged = `__Host-bps_session=${await seal("another-key-another-key-another-key", { typ: "session", id: 1, login: "someone", exp: w.platform.now() + 1e6 })}`;
  const { response } = await w.invoice(relay, { sats: 1000 }, undefined, { cookie: forged });
  assert.equal(response.status, 200);
  await w.relaySays(relay, { type: "paid", invoice: INVOICE, sats: 1000, method: "lightning" });
  assert.equal(page.messages().find((m) => m.type === "donation").donation.handle, "");
});
