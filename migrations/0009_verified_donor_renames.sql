-- Empty until an operator verifies the same GitHub account before/after a rename.
-- This projects verified donor names onto rankings; receipt snapshots stay immutable.
CREATE TABLE donor_login_migrations (
  github_id INTEGER PRIMARY KEY CHECK (github_id > 0),
  old_login TEXT NOT NULL COLLATE NOCASE,
  new_login TEXT NOT NULL COLLATE NOCASE,
  CHECK (length(old_login) BETWEEN 1 AND 39 AND length(new_login) BETWEEN 1 AND 39),
  CHECK (old_login <> new_login)
);

-- One reviewed transition per ID. Further renames/recovery require a new reviewed
-- migration; editing a mapping without rebuilding its aggregate is never allowed.
CREATE TRIGGER donor_login_migration_immutable BEFORE UPDATE ON donor_login_migrations
WHEN OLD.github_id <> NEW.github_id OR OLD.old_login <> NEW.old_login OR OLD.new_login <> NEW.new_login
BEGIN
  SELECT RAISE(ABORT, 'donor identity migration is immutable');
END;
CREATE TRIGGER donor_login_migration_retained BEFORE DELETE ON donor_login_migrations
BEGIN
  SELECT RAISE(ABORT, 'donor identity migration is immutable');
END;

-- Rebuild only the two affected names, including every other donor who used them.
-- Unverified/anonymous/custom labels never acquire identity through text matching.
CREATE TRIGGER donor_login_migration_added AFTER INSERT ON donor_login_migrations
BEGIN
  DELETE FROM handle_totals WHERE handle IN (NEW.old_login, NEW.new_login);
  INSERT INTO handle_totals (handle, milli, sats, donations)
  SELECT canonical, coalesce(sum(milli), 0), sum(sats), count(*) FROM (
    SELECT coalesce(m.new_login, d.handle) AS canonical, d.milli, d.sats
    FROM donations d LEFT JOIN donor_login_migrations m
      ON d.verified = 1 AND d.github_id = m.github_id AND d.handle = m.old_login COLLATE NOCASE
  ) WHERE canonical COLLATE NOCASE IN (NEW.old_login, NEW.new_login)
  GROUP BY canonical COLLATE NOCASE;
END;

-- Future receipts, including a delayed invoice created before the rename, use the
-- same projection. The primary-key lookup adds no request to the invoice path.
DROP TRIGGER donations_handle_totals;
CREATE TRIGGER donations_handle_totals AFTER INSERT ON donations
WHEN NEW.handle <> ''
BEGIN
  INSERT INTO handle_totals (handle, milli, sats, donations)
  VALUES (coalesce((SELECT new_login FROM donor_login_migrations
      WHERE github_id = NEW.github_id AND NEW.verified = 1 AND old_login = NEW.handle COLLATE NOCASE), NEW.handle),
    coalesce(NEW.milli, 0), NEW.sats, 1)
  ON CONFLICT (handle) DO UPDATE
  SET handle = excluded.handle, milli = milli + excluded.milli,
    sats = sats + excluded.sats, donations = donations + 1;
END;
