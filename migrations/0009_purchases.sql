-- Things bought, as against given: fireworks first, and whatever else is sold later, such as
-- costumes or merch. Purchases make no bananas, and never touch the donations table, its totals,
-- the tally or the pile. See decision 0028.
--
-- A purchase is one paid invoice; its items are what it bought, one line each, so a payment can
-- carry several things, or several of one. Items are named by category and item, and the
-- tables never list them: what is on sale, and at what price, is the code's, so selling
-- something new needs no migration. Columns can be added later; keys and checks can't be
-- changed without rebuilding a table, so these are kept general.
--
-- This is a record of sales, not of delivery: it never holds a postal address, an email or
-- anything else needed to send goods. Fulfilment, refunds and the like would each be a record
-- of their own, keyed by the purchase, never an edit of it.

-- id is the BTCPay invoice id, so a repeated payment notice changes nothing, and sats is the
-- invoice's whole amount, so each row matches one BTCPay invoice exactly. A signed-in buyer
-- keeps their numeric GitHub id, which survives a rename, and their login; an anonymous buyer
-- keeps no identifier, only the coarse nth and before their page sent.
CREATE TABLE purchases (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  sats INTEGER NOT NULL CHECK (sats > 0),
  at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('lightning', 'onchain', 'mixed')),
  github_id INTEGER,
  login TEXT,
  nth INTEGER,
  before TEXT
);
CREATE INDEX purchases_github_id ON purchases (github_id);

-- What each purchase bought. sats is what the line cost when it was bought, so a later change of
-- price leaves the record as it was, and options what the buyer chose for it, as JSON, such as
-- a firework's slot of sky, or null. Lines are numbered from 1 within their purchase.
CREATE TABLE purchase_items (
  purchase TEXT NOT NULL REFERENCES purchases (id),
  line INTEGER NOT NULL CHECK (line > 0),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 32 AND category NOT GLOB '*[^a-z0-9-]*'),
  item TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 64 AND item NOT GLOB '*[^a-z0-9-]*'),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  sats INTEGER NOT NULL CHECK (sats >= 0),
  options TEXT CHECK (options IS NULL OR json_valid(options)),
  PRIMARY KEY (purchase, line)
);
CREATE INDEX purchase_items_item ON purchase_items (category, item);

-- Each signed-in buyer's purchases by item: for the stand's plaque and their own count, and
-- later for whatever an account owns. Every row shows the login of the account's latest
-- purchase.
CREATE TABLE purchase_totals (
  github_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  category TEXT NOT NULL,
  item TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  sats INTEGER NOT NULL,
  PRIMARY KEY (github_id, category, item)
);
CREATE INDEX purchase_totals_category ON purchase_totals (category, github_id);

-- Fires only for a line actually recorded, so a repeated notice never counts twice. Anonymous
-- purchases count nowhere here.
CREATE TRIGGER purchase_items_totals AFTER INSERT ON purchase_items
WHEN (SELECT github_id FROM purchases WHERE id = NEW.purchase) IS NOT NULL
BEGIN
  INSERT INTO purchase_totals (github_id, login, category, item, quantity, sats)
  SELECT github_id, login, NEW.category, NEW.item, NEW.quantity, NEW.sats FROM purchases WHERE id = NEW.purchase
  ON CONFLICT (github_id, category, item) DO UPDATE
  SET quantity = quantity + excluded.quantity, sats = sats + excluded.sats;
  UPDATE purchase_totals SET login = (SELECT login FROM purchases WHERE id = NEW.purchase)
  WHERE github_id = (SELECT github_id FROM purchases WHERE id = NEW.purchase);
END;

-- Invoice lines made and paid, by item and the UTC hour each happened in, to show how many
-- choices end in a sale. Counts only: no ids, logins or times finer than the hour. The object
-- counts each line it asks an invoice for; this trigger counts each line recorded.
CREATE TABLE purchase_funnel (
  hour INTEGER NOT NULL,
  category TEXT NOT NULL,
  item TEXT NOT NULL,
  created INTEGER NOT NULL,
  paid INTEGER NOT NULL,
  PRIMARY KEY (hour, category, item)
);

CREATE TRIGGER purchase_items_funnel AFTER INSERT ON purchase_items
BEGIN
  INSERT INTO purchase_funnel (hour, category, item, created, paid)
  SELECT at - at % 3600000, NEW.category, NEW.item, 0, 1 FROM purchases WHERE id = NEW.purchase
  ON CONFLICT (hour, category, item) DO UPDATE SET paid = paid + 1;
END;
