-- Donation records: a feed that can be rebuilt from BTCPay, not a ledger. id is the BTCPay
-- invoice id, so a repeated payment notice changes nothing; seq orders the replay a
-- reconnecting page asks for. method is how the donor paid: over Lightning, on-chain, or, in
-- the rare case of an invoice paid partly each way, mixed.
CREATE TABLE donations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  sats INTEGER NOT NULL CHECK (sats > 0),
  handle TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('lightning', 'onchain', 'mixed'))
);
