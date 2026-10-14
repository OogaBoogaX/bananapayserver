# 0012. One global pile

**Status:** accepted, 2026-10-01

## Decision

There is one banana pile, the same for every visitor, kept by the Durable Object. It starts at
a set level. Each donation adds its exact bananas once, even when the object stops halfway
and the relay sends the notice again, and the Oogas eat at a fixed rate per hour. The pile's
clock never runs backwards. The object sends pages the level and the rate, and each page works
out the current level from the time since. Pages show whole bananas.

## Alternatives

- **A pile per page,** as OBL has today: each page starts at 1,000 and adds the donations it
  sees while open.
- **A pile per browser,** kept in local storage.
- **Eating driven by the animation,** with the object told about each banana eaten.

## Why

Donations are shared events, and a donor who adds 300 bananas expects everyone to see them.
Per-page and per-browser piles differ from visitor to visitor, and miss everything given while
a page was closed. Driving eating from animations would make the level depend on how many pages
are open and how fast they draw, and would wake the object for every banana. A fixed rate makes
the level a function of the donations and the clock, so every page agrees without the object
waking, and the pile can be rebuilt from the donations in D1.

## Consequences

- The starting level and the eating rate are settings, `PILE_START` and `PILE_EAT_PER_HOUR`.
  Their values today, 1,000 and 60 an hour, are placeholders for the team.
- Rebuilding the pile from D1 means starting at the starting level and taking the donations in
  order, each at the later of its own time and the last one's. A new eating rate applies from
  the last donation on, so a rebuild across a change needs the old rate.
- The pile and the leaderboard count the same bananas. The drop animation can still show at
  most 12 falling while the level jumps by 300.
- A returning visitor sees everything donated while they were away, which settles the question
  of missed donations.
- OBL's pile changes from one per page to the object's, through OBL's own process.
