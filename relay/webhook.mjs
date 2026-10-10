// The relay's one listener: BTCPay's webhook, on the machine's internal network, with the port
// never published. A delivery counts only if its BTCPay-Sig is right, and even then the relay
// confirms the invoice with BTCPay's API before believing it.

import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

export const WEBHOOK_PATH = "/btcpay";
// What sends the relay to look at an invoice: settling, and any payment, since a payment that
// arrives after the invoice expired settles nothing and still counts.
export const EVENTS = ["InvoiceSettled", "InvoiceReceivedPayment", "InvoicePaymentSettled"];
const MAX_BODY = 64 * 1024;

// BTCPay-Sig is "sha256=" and the hex HMAC-SHA256 of the raw body, keyed with the secret.
export function signatureValid(secret, body, header) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex"));
}

export function createWebhookServer({ secret, storeId, onPayment }) {
  const server = http.createServer((request, response) => {
    const answer = (status) => response.writeHead(status).end();
    if (request.url !== WEBHOOK_PATH) return answer(404);
    if (request.method !== "POST") return answer(405);
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        answer(413);
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (!signatureValid(secret, body, request.headers["btcpay-sig"])) return answer(401);
      answer(200);
      let event;
      try {
        event = JSON.parse(body.toString("utf8"));
      } catch {
        return;
      }
      if (EVENTS.includes(event?.type) && event.storeId === storeId && typeof event.invoiceId === "string") {
        onPayment(event.invoiceId);
      }
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  return server;
}
