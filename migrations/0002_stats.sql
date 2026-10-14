-- What each donation was worth in bananas, and who gave it. The price and the banana's price are
-- kept with the sats, so any count can be worked out again if the rule ever changes.
ALTER TABLE donations ADD COLUMN github_id INTEGER;
ALTER TABLE donations ADD COLUMN price_cents INTEGER;
ALTER TABLE donations ADD COLUMN price_at INTEGER;
ALTER TABLE donations ADD COLUMN banana_cents INTEGER;
ALTER TABLE donations ADD COLUMN milli INTEGER;

-- Each signed-in donor's running total, by GitHub's numeric id, so a renamed login keeps its
-- bananas. Anonymous donations count in the pile but never here.
CREATE TABLE totals (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  milli INTEGER NOT NULL,
  donations INTEGER NOT NULL
);
CREATE INDEX totals_milli ON totals (milli DESC);

-- Fires only for a donation actually recorded, so a repeated notice never counts twice.
CREATE TRIGGER donations_totals AFTER INSERT ON donations
WHEN NEW.github_id IS NOT NULL AND NEW.milli IS NOT NULL
BEGIN
  INSERT INTO totals (github_id, login, milli, donations)
  VALUES (NEW.github_id, NEW.handle, NEW.milli, 1)
  ON CONFLICT (github_id) DO UPDATE
  SET login = excluded.login, milli = milli + excluded.milli, donations = donations + 1;
END;
