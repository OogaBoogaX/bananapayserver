# Verified donor account rename

Migration 0009 installs an empty `donor_login_migrations` table and ranking projection. Installing it does not rename any donor. Before inserting a mapping, independently verify the old and new GitHub logins belong to the same numeric account, export/restore-test D1, snapshot affected raw donations and both handle aggregates, and review the affected counts. This accompanies OogaBoogaLand PR #457; do not activate before the account rename is verified.

Insert one reviewed `(github_id, old_login, new_login)` row atomically. The trigger rebuilds only the two affected public handles from immutable receipts, carrying across only `verified=1` donations for that ID whose entered handle matches the former login. Anonymous, legacy-unverified and custom-label donations stay as entered. Other donors with either handle retain their contributions. Installation and activation do not change receipt snapshots, payment amounts, payment identity, tally, node feeds, or retired account totals.

A delayed verified payment under the old login is projected at recording time. Duplicate payment notices still add nothing. New-name donations aggregate normally. Compare total sats, milli and counts before and after, and inspect both affected rows and unrelated rows. Public recent receipts preserve their original historical names. The existing aggregate cache must refresh before checking the live ranking.

Mapping updates/deletes are rejected when they would change meaning; another rename or rollback needs a new reviewed forward migration with aggregate verification. Do not rewrite receipts to undo a display mapping. Each ordinary donation adds one indexed mapping lookup inside the existing recording transaction; the invoice creation path has no extra request.
