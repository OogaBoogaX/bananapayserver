// The relay's work: an invoice when the object asks for one, and a notice of each payment until
// the object acknowledges it. It runs on the node's machine but never touches LND; BTCPay does.

import { btcToSats, ORDER_ID } from "./btcpay.mjs";

const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const LOOKBACK_SECONDS = 24 * 60 * 60;

export class Relay {
  constructor({ btcpay, line, config, now = Date.now, log = console.log }) {
    Object.assign(this, { btcpay, line, config, now, log });
    this.open = new Map(); // invoice id → sats: made here, not yet settled or expired
    this.unacked = new Map(); // invoice id → { sats, method }: settled, until the object acknowledges
    this.checking = new Set();
    this.recheck = new Set(); // invoice ids a webhook asked about while they were being checked
    this.sweeping = false;
    this.minute = null;
    this.asked = 0;
  }

  async handle(message) {
    if (message.type === "ack") return this.ack(message);
    if (!this.allow()) return this.line.send({ type: message.type, request: message.request, error: "unavailable" });
    if (message.type === "invoice") return this.invoice(message);
    if (message.type === "onchain") return this.onchain(message);
  }

  // Invoices and on-chain addresses are work for the node, so the relay limits how many it makes
  // in a minute, whatever the Worker asks. The Worker has limits of its own; this one holds if
  // the Worker is ever wrong, or isn't ours.
  allow() {
    const minute = Math.floor(this.now() / 60_000);
    if (this.minute !== minute) {
      this.minute = minute;
      this.asked = 0;
    }
    this.asked += 1;
    if (this.asked === this.config.ratePerMinute + 1) this.log(`relay: asked for more than ${this.config.ratePerMinute} this minute; refusing the rest`);
    return this.asked <= this.config.ratePerMinute;
  }

  // The relay checks the amount against its own cap, whatever the Worker allowed.
  async invoice({ request, sats }) {
    const { minSats, maxSats, invoiceMinutes, methods } = this.config;
    if (sats < minSats || sats > maxSats) return this.line.send({ type: "invoice", request, error: "cap" });
    try {
      const created = await this.btcpay.createInvoice({
        sats,
        minutes: invoiceMinutes,
        methods: [methods.lightning, methods.onchain],
      });
      await this.btcpay.activate(created.id, methods.lightning);
      const { destination } = await this.paymentMethod(created.id, methods.lightning);
      this.open.set(created.id, sats);
      this.line.send({
        type: "invoice",
        request,
        invoice: { id: created.id, bolt11: destination, expires: created.expirationTime },
      });
    } catch (error) {
      this.log(`invoice: ${error.message}`);
      this.line.send({ type: "invoice", request, error: "unavailable" });
    }
  }

  // Only when the donor switches: BTCPay makes the on-chain address now, not before.
  async onchain({ request, invoice }) {
    const { onchain } = this.config.methods;
    try {
      if (!this.open.has(invoice)) throw new Error("not an open invoice of this relay");
      await this.btcpay.activate(invoice, onchain);
      const { destination, due } = await this.paymentMethod(invoice, onchain);
      const sats = btcToSats(due);
      if (!sats) throw new Error("the on-chain amount isn't usable");
      this.line.send({ type: "onchain", request, address: destination, sats });
    } catch (error) {
      this.log(`onchain: ${error.message}`);
      this.line.send({ type: "onchain", request, error: "unavailable" });
    }
  }

  ack({ invoice, result }) {
    this.unacked.delete(invoice);
    if (result === "unknown" || result === "rejected") this.log(`ack: the object ${result} invoice ${invoice}`);
  }

  // Called for each webhook delivery and by the sweep. BTCPay's API decides, not the delivery. A
  // delivery that arrives while the same invoice is being checked is checked again afterwards:
  // the check under way may have read the invoice before it settled.
  async check(invoiceId) {
    if (!INVOICE_ID.test(invoiceId)) return;
    if (this.checking.has(invoiceId)) return void this.recheck.add(invoiceId);
    this.checking.add(invoiceId);
    try {
      do {
        this.recheck.delete(invoiceId);
        await this.checkOnce(invoiceId);
      } while (this.recheck.has(invoiceId));
    } finally {
      this.checking.delete(invoiceId);
    }
  }

  async checkOnce(invoiceId) {
    try {
      const invoice = await this.btcpay.invoice(invoiceId);
      if (invoice?.metadata?.orderId !== ORDER_ID) {
        this.open.delete(invoiceId);
        return;
      }
      if (invoice.status === "Expired" || invoice.status === "Invalid") {
        this.open.delete(invoiceId);
        return;
      }
      if (invoice.status !== "Settled") return;
      // The pile credits payments, so an invoice someone marked settled by hand doesn't count.
      if (invoice.additionalStatus === "Marked") {
        this.open.delete(invoiceId);
        return this.log(`check: invoice ${invoiceId} was marked by hand`);
      }
      const sats = invoice.currency === "BTC" ? btcToSats(invoice.amount) : null;
      if (!sats) {
        this.open.delete(invoiceId);
        return this.log(`check: invoice ${invoiceId} has an amount the relay can't read`);
      }
      const method = this.paidWith(await this.btcpay.paymentMethods(invoiceId));
      // Settled with no payment to show for it shouldn't happen; the invoice stays open, so the
      // sweep asks again and the log keeps saying so.
      if (!method) return this.log(`check: invoice ${invoiceId} is settled, but BTCPay lists no payment for it`);
      this.open.delete(invoiceId);
      this.unacked.set(invoiceId, { sats, method });
      this.line.send({ type: "paid", invoice: invoiceId, sats, method });
    } catch (error) {
      // An invoice BTCPay no longer knows will never settle.
      if (error.status === 404) this.open.delete(invoiceId);
      this.log(`check: ${error.message}`);
    }
  }

  // Sends every notice the object hasn't acknowledged. Repeats are harmless: the object
  // records each invoice once.
  flush() {
    for (const [invoice, { sats, method }] of this.unacked) this.line.send({ type: "paid", invoice, sats, method });
  }

  // Once a minute: resends what's still unacknowledged, then catches any webhook that never
  // arrived. In that order, a notice found now isn't sent twice before its ack can arrive.
  // A sweep still going when the next is due lets it finish instead of starting another.
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      this.flush();
      for (const invoiceId of [...this.open.keys()]) await this.check(invoiceId);
    } finally {
      this.sweeping = false;
    }
  }

  // After a reboot the relay may start before BTCPay does, so finding its invoices again keeps
  // trying, with growing delays, until BTCPay answers.
  async loadWhenReady({ wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxDelayMs = 60_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.load();
        await this.sweep();
        return;
      } catch (error) {
        this.log(`load: ${error.message}; trying again`);
        await wait(Math.min(maxDelayMs, 1_000 * 2 ** attempt));
      }
    }
  }

  // After a restart, find the relay's invoices from the last day again. Settled ones go back to
  // the open list too, so the next check works out how each was paid and sends its notice; the
  // object ignores any it already has.
  async load() {
    const since = Math.floor(this.now() / 1_000) - LOOKBACK_SECONDS;
    for (const invoice of await this.btcpay.recent(since)) {
      const sats = invoice.currency === "BTC" ? btcToSats(invoice.amount) : null;
      if (invoice.metadata?.orderId !== ORDER_ID || !sats || !INVOICE_ID.test(invoice.id)) continue;
      if (["New", "Processing", "Settled"].includes(invoice.status) && invoice.additionalStatus !== "Marked") {
        this.open.set(invoice.id, sats);
      }
    }
  }

  // How the donor paid, from the payment methods that received a payment BTCPay hasn't ruled
  // invalid: over Lightning, on-chain, or mixed if both did. Null if neither did.
  paidWith(methods) {
    const { lightning, onchain } = this.config.methods;
    const paid = new Set((methods ?? [])
      .filter((m) => (m.payments ?? []).some((payment) => payment.status !== "Invalid"))
      .map((m) => m.paymentMethodId ?? m.paymentMethod));
    if (paid.has(lightning) && paid.has(onchain)) return "mixed";
    if (paid.has(lightning)) return "lightning";
    if (paid.has(onchain)) return "onchain";
    return null;
  }

  async paymentMethod(invoiceId, method) {
    const methods = await this.btcpay.paymentMethods(invoiceId);
    // BTCPay 2 names the field paymentMethodId; 1.x called it paymentMethod.
    const found = methods?.find((m) => (m.paymentMethodId ?? m.paymentMethod) === method);
    if (!found?.destination) throw new Error(`BTCPay gave no ${method} destination`);
    return found;
  }
}
