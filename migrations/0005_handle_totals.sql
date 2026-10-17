-- Public rankings follow the entered display handle, independently of account identity.
-- Preserve the amounts recorded for each donation and combine matching names without case.
-- Legacy unnamed donations still count in the global tally, but have no name to rank.
CREATE TABLE handle_totals (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  milli INTEGER NOT NULL,
  sats INTEGER NOT NULL,
  donations INTEGER NOT NULL
);
INSERT INTO handle_totals (handle, milli, sats, donations)
SELECT latest.handle, grouped.milli, grouped.sats, grouped.donations
FROM (
  SELECT coalesce(sum(milli), 0) AS milli, sum(sats) AS sats, count(*) AS donations,
    max(seq) AS latest_seq
  FROM donations WHERE handle <> '' GROUP BY handle COLLATE NOCASE
) AS grouped
JOIN donations AS latest ON latest.seq = grouped.latest_seq;
CREATE INDEX handle_totals_milli ON handle_totals (milli DESC, handle);
CREATE INDEX handle_totals_sats ON handle_totals (sats DESC, handle);

CREATE TRIGGER donations_handle_totals AFTER INSERT ON donations
WHEN NEW.handle <> ''
BEGIN
  INSERT INTO handle_totals (handle, milli, sats, donations)
  VALUES (NEW.handle, coalesce(NEW.milli, 0), NEW.sats, 1)
  ON CONFLICT (handle) DO UPDATE
  SET handle = excluded.handle, milli = milli + excluded.milli,
    sats = sats + excluded.sats, donations = donations + 1;
END;
