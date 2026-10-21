-- A check on a recent donation means its signed-in GitHub login matched its final
-- displayed donor name. Older donations had no recorded login, so remain unverified.
ALTER TABLE donations ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));
