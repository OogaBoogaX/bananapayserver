-- The board's figures, the same in every browser: every donation recorded, all time, and each
-- hour's donations, by the UTC hour they were recorded in. A trigger keeps them up to date
-- with each donation recorded, so nothing sums the donations table to show them, and they
-- start from the donations already recorded.
CREATE TABLE tally (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  count INTEGER NOT NULL,
  sats INTEGER NOT NULL,
  milli INTEGER NOT NULL,
  last INTEGER
);
CREATE TABLE tally_hours (
  hour INTEGER PRIMARY KEY,
  sats INTEGER NOT NULL,
  milli INTEGER NOT NULL
);

INSERT INTO tally (id, count, sats, milli, last)
SELECT 1, count(*), coalesce(sum(sats), 0), coalesce(sum(milli), 0),
  (SELECT sats FROM donations ORDER BY seq DESC LIMIT 1)
FROM donations;
INSERT INTO tally_hours (hour, sats, milli)
SELECT at - at % 3600000, sum(sats), coalesce(sum(milli), 0) FROM donations GROUP BY at - at % 3600000;

-- Fires only for a donation actually recorded, so a repeated notice never counts twice. One
-- recorded without a price counts its sats and no bananas.
CREATE TRIGGER donations_tally AFTER INSERT ON donations
BEGIN
  UPDATE tally
  SET count = count + 1, sats = sats + NEW.sats, milli = milli + coalesce(NEW.milli, 0), last = NEW.sats
  WHERE id = 1;
  INSERT INTO tally_hours (hour, sats, milli)
  VALUES (NEW.at - NEW.at % 3600000, NEW.sats, coalesce(NEW.milli, 0))
  ON CONFLICT (hour) DO UPDATE SET sats = sats + excluded.sats, milli = milli + excluded.milli;
END;
