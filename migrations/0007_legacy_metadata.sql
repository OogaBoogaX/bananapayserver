-- Entered display handles are not account logins. Retain the old account totals as history;
-- only the handle totals and global tally continue to accumulate new donations.
DROP TRIGGER donations_totals;

-- Legacy invoice quotes never recorded freshness. Correct the default copied by the earlier
-- backend without changing their price or any receipt-priced donation's snapshot.
UPDATE donations SET price_stale = NULL WHERE pricing = 'invoice';
