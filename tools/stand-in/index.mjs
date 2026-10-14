// A stand-in for OBL's Worker, for testing on one machine. It serves the stand-in page and passes
// the page's calls to the local bananapayserver over a service binding, the way OBL's Worker does
// (docs/protocol.md). There's no sign-in here, so the page names a test donor itself; OBL's
// Worker takes the donor from its own GitHub sign-in. Never deployed.

const CALLS = { "/donations/invoice": "invoice", "/donations/note": "note", "/donations/onchain": "onchain" };
const SOCKET_HEADERS = ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const visitor = request.headers.get("CF-Connecting-IP") ?? "local";
    // Only the page's own calls, as OBL's Worker checks with its fromSite.
    if (!fromSite(request, url)) return Response.json({ error: "forbidden" }, { status: 403 });
    try {
      if (url.pathname === "/donations/socket") return await env.DONATIONS.fetch(socketRequest(request, url, visitor));
      const method = CALLS[url.pathname];
      if (!method || request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
      // Only the page's body and its type go on, never the browser's own request and its cookies.
      const call = new Request(url, {
        method: "POST",
        headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
        body: request.body,
      });
      if (method === "invoice") return await env.DONATIONS.invoice(call, donorOf(request, url), visitor);
      return await env.DONATIONS[method](call, visitor);
    } catch {
      // bananapayserver can't be reached, so the page hears that donations are closed.
      return Response.json({ error: "closed" }, { status: 503 });
    }
  },
};

// The socket's upgrade, with the visitor's address set here, whatever the browser sent.
function socketRequest(request, url, visitor) {
  const headers = new Headers({ "X-Client": visitor });
  for (const name of SOCKET_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(url, { headers });
}

// A call from the page itself: a matching Origin, or same-origin fetch metadata.
function fromSite(request, url) {
  const origin = request.headers.get("Origin");
  return origin ? origin === url.origin : request.headers.get("Sec-Fetch-Site") === "same-origin";
}

// The test donor the page named, or nobody, and only on this machine: anywhere else a browser
// could name anyone. bananapayserver checks the shape.
function donorOf(request, url) {
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
  const id = request.headers.get("X-Test-Donor-Id"), login = request.headers.get("X-Test-Donor-Login");
  return id || login ? { id: Number(id), login: login ?? "" } : null;
}
