-- The D1 projection of receipt accounting: lifetime figures from receipt-mode credits, applied
-- from the object's outbox one committed receipt revision at a time. Nothing here is written
-- into donations: receipt credits never pass through the legacy insert triggers, so they can't
-- be counted twice, and legacy rows, prices and markers are never changed.
--
-- receipt_applied: one marker per applied (receipt, revision), with the hash of exactly what was
-- applied. A revision applied once is never applied again; the same revision with a different
-- payload is a conflict for review, never a silent success.
CREATE TABLE receipt_applied (
  receipt TEXT NOT NULL,
  revision INTEGER NOT NULL,
  hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (receipt, revision)
);

-- receipt_projection: the newest applied revision of each receipt, so an older revision
-- arriving later can never overwrite it, and each new revision's change is worked out against
-- what was last applied. No owner, address, provider id or outpoint is kept here. seq is the
-- applied revision's feed sequence; observed_seq is the feed sequence of the receipt's first
-- observation, written with its first row and never updated, whichever revision came first.
CREATE TABLE receipt_projection (
  receipt TEXT PRIMARY KEY,
  invoice TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  observed_seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  sats INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  milli INTEGER NOT NULL,
  handle TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX receipt_projection_invoice ON receipt_projection (invoice);
-- The newest credited receipt, by when it was first observed, for the tally's `last`.
CREATE INDEX receipt_projection_credited ON receipt_projection (received_at, observed_seq) WHERE credit > 0;
-- The newest legacy donation, likewise.
CREATE INDEX donations_at ON donations (at, seq);

-- receipt_invoices: every invoice id the projection has seen in receipt mode. It only fences
-- the two modes apart: an invoice id is legacy or receipt-mode, never both, so invoice-level
-- and receipt-level ingestion can never both credit the same payment. A refused projection
-- batch rolls back whole and is held for review.
CREATE TABLE receipt_invoices (invoice TEXT PRIMARY KEY);

CREATE TRIGGER receipt_invoices_legacy_fence BEFORE INSERT ON receipt_invoices
WHEN EXISTS (SELECT 1 FROM donations WHERE id = NEW.invoice)
BEGIN
  SELECT RAISE(ABORT, 'receipt projection: invoice is a legacy donation');
END;

-- The legacy insert trigger from 0003, replaced so a legacy donation recorded after a newer
-- receipt, or with an older `at` than one already recorded, can't take the tally's `last`. It
-- keeps 0003's count, sats, bananas and hourly figures exactly; only `last` changes. It is now
-- the newest valid donation, legacy or receipt, chosen by the same query the receipt projection
-- uses (worker/projection.mjs, LATEST): legacy by `at` then `seq`, receipts by first
-- observation then its feed sequence, and a receipt first at the same millisecond. `last` is set
-- here, in the one trigger that moves the tally, so it never depends on the order SQLite runs
-- several AFTER INSERT triggers in. Existing figures are left as they are.
DROP TRIGGER donations_tally;
CREATE TRIGGER donations_tally AFTER INSERT ON donations
BEGIN
  UPDATE tally
  SET count = count + 1, sats = sats + NEW.sats, milli = milli + coalesce(NEW.milli, 0),
    last = (SELECT sats FROM (SELECT sats, at AS t, 0 AS k, seq AS o FROM (SELECT sats, at, seq FROM donations ORDER BY at DESC, seq DESC LIMIT 1) UNION ALL SELECT sats, received_at AS t, 1 AS k, observed_seq AS o FROM (SELECT sats, received_at, observed_seq FROM receipt_projection WHERE credit > 0 ORDER BY received_at DESC, observed_seq DESC LIMIT 1)) ORDER BY t DESC, k DESC, o DESC LIMIT 1)
  WHERE id = 1;
  INSERT INTO tally_hours (hour, sats, milli)
  VALUES (NEW.at - NEW.at % 3600000, NEW.sats, coalesce(NEW.milli, 0))
  ON CONFLICT (hour) DO UPDATE SET sats = sats + excluded.sats, milli = milli + excluded.milli;
END;

CREATE TRIGGER donations_receipt_fence BEFORE INSERT ON donations
WHEN EXISTS (SELECT 1 FROM receipt_invoices WHERE invoice = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'donation: invoice is receipt-mode');
END;

-- receipt_account_totals: each signed-in account's receipt-mode contributions, by the stable
-- account id saved when the invoice was issued, never by handle. Private: no page is ever sent
-- it. The legacy `totals` table stays as it has been since 0007, history only.
CREATE TABLE receipt_account_totals (
  owner INTEGER PRIMARY KEY,
  sats INTEGER NOT NULL CHECK (sats >= 0),
  milli INTEGER NOT NULL CHECK (milli >= 0),
  donations INTEGER NOT NULL CHECK (donations >= 0)
);

-- receipt_projection_guard: never holds a row. The last statement of every projection batch
-- that moves a total inserts one, and this trigger reads the values the batch leaves, inside
-- the same transaction. Legacy deliveries move the same totals and can land between a drain's
-- reads and its batch, so only the values here are trusted. Any total that is not an exact
-- integer (SQLite turns an overflowing sum into a REAL), beyond 2^53 - 1, or negative aborts
-- the whole batch: marker, projection and every total roll back, and the work is held for
-- review. Otherwise the insert is silently skipped.
CREATE TABLE receipt_projection_guard (hour INTEGER NOT NULL, handle TEXT, owner INTEGER);

CREATE TRIGGER receipt_projection_guard_check BEFORE INSERT ON receipt_projection_guard
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (SELECT 1 FROM tally WHERE id = 1
      AND typeof(count) = 'integer' AND count BETWEEN 0 AND 9007199254740991
      AND typeof(sats) = 'integer' AND sats BETWEEN 0 AND 9007199254740991
      AND typeof(milli) = 'integer' AND milli BETWEEN 0 AND 9007199254740991)
    OR NOT EXISTS (SELECT 1 FROM tally_hours WHERE hour = NEW.hour
      AND typeof(sats) = 'integer' AND sats BETWEEN 0 AND 9007199254740991
      AND typeof(milli) = 'integer' AND milli BETWEEN 0 AND 9007199254740991)
    OR (NEW.handle IS NOT NULL AND NOT EXISTS (SELECT 1 FROM handle_totals WHERE handle = NEW.handle
      AND typeof(sats) = 'integer' AND sats BETWEEN 0 AND 9007199254740991
      AND typeof(milli) = 'integer' AND milli BETWEEN 0 AND 9007199254740991
      AND typeof(donations) = 'integer' AND donations BETWEEN 0 AND 9007199254740991))
    OR (NEW.owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM receipt_account_totals WHERE owner = NEW.owner
      AND typeof(sats) = 'integer' AND sats BETWEEN 0 AND 9007199254740991
      AND typeof(milli) = 'integer' AND milli BETWEEN 0 AND 9007199254740991
      AND typeof(donations) = 'integer' AND donations BETWEEN 0 AND 9007199254740991))
  THEN RAISE(ABORT, 'receipt projection: unsafe total') END;
  SELECT RAISE(IGNORE);
END;
