// A SOCKS5 CONNECT (RFC 1928) through a proxy such as Tor's, with no authentication. The host
// name goes to the proxy unresolved, so the lookup happens over Tor too and nothing reaches
// the machine's own DNS.

import net from "node:net";

const REPLIES = {
  1: "general failure",
  2: "not allowed by the proxy",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

export function socksConnect({ proxy, host, port, timeoutMs = 30_000 }) {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return Promise.reject(new Error("host name is not valid for SOCKS"));
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let stage = "greeting";
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("SOCKS proxy timed out")), timeoutMs);

    function fail(error) {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }

    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        if (buffered[0] !== 5 || buffered[1] !== 0) return fail(new Error("SOCKS proxy refused the greeting"));
        buffered = buffered.subarray(2);
        stage = "connect";
        const name = Buffer.from(host, "ascii");
        socket.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, name.length]),
          name,
          Buffer.from([port >> 8, port & 0xff]),
        ]));
      }
      if (buffered.length < 5) return;
      if (buffered[0] !== 5) return fail(new Error("SOCKS proxy answered with another version"));
      if (buffered[1] !== 0) return fail(new Error(`SOCKS proxy could not connect: ${REPLIES[buffered[1]] ?? buffered[1]}`));
      const address = { 1: 4, 3: 1 + buffered[4], 4: 16 }[buffered[3]];
      if (address === undefined) return fail(new Error("SOCKS proxy answered with an unknown address type"));
      if (buffered.length < 4 + address + 2) return;
      // We speak first on this stream, so the proxy has nothing more to send yet.
      if (buffered.length > 4 + address + 2) return fail(new Error("SOCKS proxy sent unexpected data"));
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      resolve(socket);
    }

    socket.on("data", onData);
    socket.on("error", fail);
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
  });
}
