# 0007. Every commit is AI-assisted and names the model

**Status:** accepted, 2026-09-30

## Decision

Every commit to bananapayserver is written with AI assistance and carries a `Co-Authored-By`
trailer naming the specific model, with the vendor's own noreply address where one exists.
Any assistant qualifies. A pull request whose code was substantially AI-generated says so in
its description and names the tool. This is Lightning Foundry's
[decision 0005](https://github.com/OogaBoogaX/lightningfoundry/blob/main/docs/decisions/0005-ai-assisted-commits.md),
adopted here unchanged.

## Alternatives

- **Permit AI assistance**, and require disclosure when it is used.
- **No policy.**

## Why

Requiring assistance rather than permitting it makes it a property of the project rather than
a description of it. Naming the model makes provenance auditable: a reviewer knows how a
change was produced, and a pattern of mistakes can later be traced to the model that made it.
That matters more, not less, in code that decides where donations go. And the node feed has
one end in Foundry and the other here, so one rule for both means a contributor to either
follows the same practice.

## Consequences

- A commit without a trailer is incomplete, the same as a commit without a message.
- Contributors need an assistant of their own choosing; the project prescribes none.
- The pull request template asks for the trailer on every commit.
