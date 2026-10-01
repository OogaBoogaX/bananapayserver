// The relay's work: an invoice when the object asks for one, and a notice of each payment until
// the object acknowledges it. It runs on the node's machine but never touches LND; BTCPay does.

import { btcToSats, ORDER_ID } from "./btcpay.mjs";

const INVOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const LOOKBACK_SECONDS = 24 * 60 * 60;

export class Relay {
  constructor({ btcpay, line, config, now = Date.now, log = console.log }) {
    Object.assign(this, { btcpay, line, config, now, log });
    this.open = new Map(); // invoice id → sats: made here, not yet settled or expired
    this.unacked = new Map(); // invoice id → sats: settled, until the object acknowledges
    this.checking = new Set();
  }

  async handle(message) {
    if (message.type === "invoice") return this.invoice(message);
    if (message.type === "onchain") return this.onchain(message);
    if (message.type === "ack") return this.ack(message);
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

  // Called for each webhook delivery and by the sweep. BTCPay's API decides, not the delivery.
  async check(invoiceId) {
    if (!INVOICE_ID.test(invoiceId) || this.checking.has(invoiceId)) return;
    this.checking.add(invoiceId);
    try {
      const invoice = await this.btcpay.invoice(invoiceId);
      if (invoice?.metadata?.orderId !== ORDER_ID) return;
      if (invoice.status === "Expired" || invoice.status === "Invalid") {
        this.open.delete(invoiceId);
        return;
      }
      if (invoice.status !== "Settled") return;
      this.open.delete(invoiceId);
      // The pile credits payments, so an invoice someone marked settled by hand doesn't count.
      if (invoice.additionalStatus === "Marked") return this.log(`check: invoice ${invoiceId} was marked by hand`);
      const sats = invoice.currency === "BTC" ? btcToSats(invoice.amount) : null;
      if (!sats) return this.log(`check: invoice ${invoiceId} has an amount the relay can't read`);
      this.unacked.set(invoiceId, sats);
      this.line.send({ type: "paid", invoice: invoiceId, sats });
    } catch (error) {
      this.log(`check: ${error.message}`);
    } finally {
      this.checking.delete(invoiceId);
    }
  }

  // Sends every notice the object hasn't acknowledged. Repeats are harmless: the object
  // ignores them by invoice id.
  flush() {
    for (const [invoice, sats] of this.unacked) this.line.send({ type: "paid", invoice, sats });
  }

  // Once a minute: catches any webhook that never arrived, then resends what's unacknowledged.
  async sweep() {
    for (const invoiceId of [...this.open.keys()]) await this.check(invoiceId);
    this.flush();
  }

  // After a restart, find the relay's invoices from the last day again.
  async load() {
    const since = Math.floor(this.now() / 1_000) - LOOKBACK_SECONDS;
    for (const invoice of await this.btcpay.recent(since)) {
      const sats = invoice.currency === "BTC" ? btcToSats(invoice.amount) : null;
      if (invoice.metadata?.orderId !== ORDER_ID || !sats || !INVOICE_ID.test(invoice.id)) continue;
      if (invoice.status === "New" || invoice.status === "Processing") this.open.set(invoice.id, sats);
      if (invoice.status === "Settled" && invoice.additionalStatus !== "Marked") this.unacked.set(invoice.id, sats);
    }
  }

  async paymentMethod(invoiceId, method) {
    const methods = await this.btcpay.paymentMethods(invoiceId);
    // BTCPay 2 names the field paymentMethodId; 1.x called it paymentMethod.
    const found = methods?.find((m) => (m.paymentMethodId ?? m.paymentMethod) === method);
    if (!found?.destination) throw new Error(`BTCPay gave no ${method} destination`);
    return found;
  }
}
