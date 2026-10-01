# 0006. The Ooga Booga License

**Status:** accepted, 2026-09-30

## Decision

bananapayserver uses The Ooga Booga License, the same public-domain dedication as the other
OogaBoogaX repositories, with its `LICENSE` copied unchanged from Lightning Foundry.
Contributions are made under it. Foundry's
[decision 0007](https://github.com/OogaBoogaX/lightningfoundry/blob/main/docs/decisions/0007-ooga-booga-license.md)
records the organization's choice.

## Alternatives

- **Apache-2.0**, whose explicit patent grant and well-tested disclaimer Foundry once called
  the safer default for software that moves money, and used as a placeholder until the
  organization settled on one dedication.
- **No license until there is code**, which reserves all rights.

## Why

The organization uses one public-domain dedication across its projects. Starting under it
means this repository never needs relicensing, so no contributor ever has to be asked again,
and a contribution's terms are the same here as anywhere else in OogaBoogaX. No license would
reserve all rights, which suits an open repository worse.

## Consequences

- `LICENSE` is the same text, byte for byte, as in the other OogaBoogaX repositories.
- Every contribution is made under it, maintainers' included, and the pull request template
  asks each contributor to confirm it.
- Changing the license takes a new record.
