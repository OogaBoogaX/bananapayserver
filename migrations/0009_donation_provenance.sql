-- Which settlement wrote each donation. The object saves a random token with the pending
-- request before it inserts, and the insert carries it, so after a crash between the insert
-- and the pile credit, a retry can prove the existing row is its own. Rows from before this
-- migration, and rows written by hand, have none: a conflict with one of them is held for
-- review and never credited. Timestamps are never taken as that proof.
ALTER TABLE donations ADD COLUMN provenance TEXT;
