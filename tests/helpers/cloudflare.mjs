// Stand-ins for the parts of the Workers runtime the Worker and its object use: the object's
// SQL storage and D1 (both SQLite, here through node:sqlite), hibernatable sockets, and the
// object's namespace. Enough to run front.mjs and object.mjs under node --test.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DonationsObject } from "../../worker/object.mjs";

export const OPEN = 1;

export function fakeStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query, ...bindings) {
        // Several statements at once, like the schema, run without results.
        if (bindings.length === 0 && query.trim().replace(/;\s*$/, "").includes(";")) {
          db.exec(query);
          return cursor([]);
        }
        return cursor(db.prepare(query).all(...bindings));
      },
    },
  };
}

function cursor(rows) {
  return {
    toArray: () => rows,
    one() {
      if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
      return rows[0];
    },
  };
}

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../migrations/0001_donations.sql", import.meta.url), "utf8"));
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    run: async () => {
      const result = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { db, prepare: (sql) => statement(sql) };
}

export class FakeSocket {
  constructor() {
    this.sent = [];
    this.readyState = 0;
    this.closedWith = null;
    this.attachment = null;
  }

  send(text) {
    if (this.readyState !== OPEN) throw new Error("socket is not open");
    this.sent.push(text);
  }

  close(code, reason) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return this.attachment;
  }

  messages() {
    return this.sent.map((text) => JSON.parse(text));
  }
}

export function fakeCtx() {
  const sockets = [];
  return {
    storage: fakeStorage(),
    acceptWebSocket(ws, tags = []) {
      ws.readyState = OPEN;
      sockets.push({ ws, tags });
    },
    getWebSockets(tag) {
      return sockets.filter((s) => s.ws.readyState !== 3 && (!tag || s.tags.includes(tag))).map((s) => s.ws);
    },
  };
}

// Deterministic time and ids, and plain objects where the runtime would make a 101 response.
export function fakePlatform({ start = Date.UTC(2026, 9, 1, 12) } = {}) {
  let time = start;
  let counter = 0;
  return {
    pair: () => [new FakeSocket(), new FakeSocket()],
    upgrade: (client) => ({ status: 101, webSocket: client }),
    now: () => time,
    id: () => (++counter).toString(16).padStart(32, "0"),
    advance: (ms) => {
      time += ms;
    },
  };
}

export const ENV = {
  MAX_SATS: "100000",
  RATE_PER_IP: "5",
  RATE_GLOBAL: "50",
  NETWORK: "regtest",
  ALLOWED_ORIGINS: "https://oogabooga.land",
  INVOICE_TIMEOUT_MS: "200",
};

// The object behind a namespace binding, the way env.DONATIONS looks to the Worker.
export function fakeWorld(overrides = {}) {
  const ctx = fakeCtx();
  const platform = fakePlatform();
  const env = { ...ENV, DB: fakeD1(), ...overrides };
  const object = new DonationsObject(ctx, env, platform);
  env.DONATIONS = {
    idFromName: (name) => name,
    get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }),
  };
  return { ctx, env, object, platform };
}

// Waits until a condition holds, letting promises and timers run in between.
export async function until(condition, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
