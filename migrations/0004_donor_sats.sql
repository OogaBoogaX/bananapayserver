-- Each signed-in donor's sats, including donations recorded without a banana price. Rebuild
-- the totals from recorded donations once, retaining the latest login for each GitHub id.
ALTER TABLE totals ADD COLUMN sats INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER donations_totals;
DELETE FROM totals;
INSERT INTO totals (github_id, login, milli, donations, sats)
SELECT grouped.github_id, latest.handle, grouped.milli, grouped.donations, grouped.sats
FROM (
  SELECT github_id, coalesce(sum(milli), 0) AS milli, count(*) AS donations,
    sum(sats) AS sats, max(seq) AS latest_seq
  FROM donations WHERE github_id IS NOT NULL GROUP BY github_id
) AS grouped
JOIN donations AS latest ON latest.seq = grouped.latest_seq;
CREATE INDEX totals_sats ON totals (sats DESC, github_id);

-- Only a newly recorded donation changes the totals. A repeated payment notice adds nothing.
CREATE TRIGGER donations_totals AFTER INSERT ON donations
WHEN NEW.github_id IS NOT NULL
BEGIN
  INSERT INTO totals (github_id, login, milli, donations, sats)
  VALUES (NEW.github_id, NEW.handle, coalesce(NEW.milli, 0), 1, NEW.sats)
  ON CONFLICT (github_id) DO UPDATE
  SET login = excluded.login, milli = milli + excluded.milli,
    donations = donations + 1, sats = sats + excluded.sats;
END;
