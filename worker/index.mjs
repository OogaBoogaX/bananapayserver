// The entry points Cloudflare runs. Everything here is wiring to the Workers runtime; the logic
// lives in front.mjs and object.mjs, which the tests run without it.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { handle, pageApi } from "./front.mjs";
import { DonationsObject } from "./object.mjs";

const platform = {
  pair: () => Object.values(new WebSocketPair()),
  upgrade: (client) => new Response(null, { status: 101, webSocket: client }),
  now: () => Date.now(),
  id: () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""),
  fetch: (input, init) => fetch(input, init),
  socket: (url) => new WebSocket(url),
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

// The page's calls, from OBL's Worker over its service binding. A named entrypoint is reachable
// only through a binding, never from the internet. See docs/protocol.md.
export class PageApi extends WorkerEntrypoint {
  invoice(request, donor, visitor) {
    return pageApi(this.env).invoice(request, donor, visitor);
  }

  note(request, visitor) {
    return pageApi(this.env).note(request, visitor);
  }

  onchain(request, visitor) {
    return pageApi(this.env).onchain(request, visitor);
  }

  fetch(request) {
    return pageApi(this.env).fetch(request);
  }
}

// The public address, which takes only the relay's line.
export default {
  fetch: (request, env) => handle(request, env),
};
