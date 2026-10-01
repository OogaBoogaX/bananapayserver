// The relay's calls to BTCPay's Greenfield API, on the machine's internal network. The relay's
// key can only create and view invoices on one store, which is all these calls need. The
// store-scoped paths work from BTCPay 1.13 through 2.4.

// Every invoice the relay makes carries this order id, so it can find its own again.
export const ORDER_ID = "bananapayserver";

const ID = /^[A-Za-z0-9-]{1,64}$/;

export const satsToBtc = (sats) => {
  const value = BigInt(sats);
  return `${value / 100_000_000n}.${(value % 100_000_000n).toString().padStart(8, "0")}`;
};

// Whole sats from a BTC decimal string, or null if it isn't one or holds a fraction of a sat.
export function btcToSats(text) {
  const match = /^(\d{1,8})(?:\.(\d{1,12}))?$/.exec(String(text));
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(12, "0");
  if (fraction.slice(8) !== "0000") return null;
  return Number(BigInt(match[1]) * 100_000_000n + BigInt(fraction.slice(0, 8)));
}

export class BTCPay {
  constructor({ url, storeId, apiKey, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
    this.url = url;
    this.store = `/api/v1/stores/${encodeURIComponent(storeId)}`;
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  // Payment methods stay inactive until asked for, so making the invoice doesn't wait for an
  // on-chain address the donor may never want.
  createInvoice({ sats, minutes, methods }) {
    return this.#call("POST", "/invoices", {
      amount: satsToBtc(sats),
      currency: "BTC",
      metadata: { orderId: ORDER_ID },
      checkout: {
        paymentMethods: methods,
        defaultPaymentMethod: methods[0],
        lazyPaymentMethods: true,
        expirationMinutes: minutes,
      },
    });
  }

  activate(invoiceId, method) {
    return this.#call("POST", `/invoices/${id(invoiceId)}/payment-methods/${id(method)}/activate`);
  }

  paymentMethods(invoiceId) {
    return this.#call("GET", `/invoices/${id(invoiceId)}/payment-methods`);
  }

  invoice(invoiceId) {
    return this.#call("GET", `/invoices/${id(invoiceId)}`);
  }

  // The relay's invoices made since a time, in unix seconds, that may still need its attention.
  recent(sinceSeconds) {
    const query = new URLSearchParams({ orderId: ORDER_ID, startDate: String(sinceSeconds), take: "500" });
    for (const status of ["New", "Processing", "Settled"]) query.append("status", status);
    return this.#call("GET", `/invoices?${query}`);
  }

  async #call(method, path, body) {
    const response = await this.fetch(new URL(this.store + path, this.url), {
      method,
      headers: {
        Authorization: `token ${this.apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Errors name the call, never BTCPay's address.
    if (!response.ok) throw new Error(`BTCPay answered ${response.status} to ${method} ${path.split("?")[0]}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

function id(value) {
  if (!ID.test(String(value))) throw new Error("not a BTCPay id");
  return value;
}
