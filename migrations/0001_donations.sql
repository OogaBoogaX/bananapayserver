-- Donation records: a feed that can be rebuilt from BTCPay, not a ledger. id is the BTCPay
-- invoice id, so a repeated payment notice changes nothing; seq orders the replay a
-- reconnecting page asks for.
CREATE TABLE donations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  sats INTEGER NOT NULL CHECK (sats > 0),
  handle TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
