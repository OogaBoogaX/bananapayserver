// The entry point Cloudflare runs. Everything here is wiring to the Workers runtime; the logic
// lives in front.mjs and object.mjs, which the tests run without it.

import { DurableObject } from "cloudflare:workers";
import { handle } from "./front.mjs";
import { DonationsObject } from "./object.mjs";

const platform = {
  pair: () => Object.values(new WebSocketPair()),
  upgrade: (client) => new Response(null, { status: 101, webSocket: client }),
  now: () => Date.now(),
  id: () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""),
};

export class Donations extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.object = new DonationsObject(ctx, env, platform);
  }

  fetch(request) {
    return this.object.fetch(request);
  }

  webSocketMessage(ws, message) {
    return this.object.webSocketMessage(ws, message);
  }

  webSocketClose(ws, code, reason, wasClean) {
    return this.object.webSocketClose(ws, code, reason, wasClean);
  }

  webSocketError(ws, error) {
    return this.object.webSocketError(ws, error);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
};
