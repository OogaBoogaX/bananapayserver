-- Existing donations keep their original invoice price. New receipt-priced donations record
-- when full payment was first detected and whether the recorded price was a stale fallback.
ALTER TABLE donations ADD COLUMN received_at INTEGER;
ALTER TABLE donations ADD COLUMN price_stale INTEGER;
ALTER TABLE donations ADD COLUMN pricing TEXT NOT NULL DEFAULT 'invoice';
