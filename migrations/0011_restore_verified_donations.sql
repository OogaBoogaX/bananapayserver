-- Migration 0008 left every older donation unverified because none recorded its donor's login.
-- Invoice-priced rows prove the match: before editable handles, the invoice took a signed-in
-- donor's handle from their login. This also covers old pending invoices settled after 0008.
-- Receipt-priced rows stay as recorded. The historical totals.login may be an account's old
-- name after a GitHub rename, and D1 has no per-row login or reliable deployment cutoff to
-- distinguish an old match from one settlement deliberately left unchecked. Any repair of
-- those rows needs separate evidence and review.
-- Unnamed donations and donations without a GitHub id stay unverified. Nothing here changes an
-- amount, a name, a total or the tally: no trigger reads an update.
UPDATE donations SET verified = 1
WHERE verified = 0 AND github_id IS NOT NULL AND handle <> '' AND pricing = 'invoice';
