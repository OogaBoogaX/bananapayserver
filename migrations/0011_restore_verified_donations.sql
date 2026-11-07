-- Migration 0008 left every older donation unverified because none recorded its donor's login.
-- Some prove the same match 0008 checks, signed in with GitHub under that account's login, ignoring
-- case, so they get their check back:
-- - Rows priced at invoice (`pricing = 'invoice'`, every donation from before editable handles):
--   the invoice took a signed-in donor's handle from their login, so the handle is the login.
-- - Later rows from before logins were recorded, whose handle is the login the account totals kept
--   for that GitHub id. Those totals took only invoice-era handles; migration 0007 stopped them
--   updating when handles became editable.
-- Unnamed donations and donations without a GitHub id stay unverified. Nothing here changes an
-- amount, a name, a total or the tally: no trigger reads an update.
UPDATE donations SET verified = 1
WHERE verified = 0 AND github_id IS NOT NULL AND handle <> ''
  AND (pricing = 'invoice'
    OR handle = (SELECT login FROM totals WHERE totals.github_id = donations.github_id) COLLATE NOCASE);
