// Values for the tests that are obviously synthetic: none of them is payable or anyone's.

export const REQUEST = "0".repeat(31) + "1";
export const INVOICE = "Inv0ice1234";
// The right shape for a regtest invoice of 1,000 sats, with a body of filler.
export const BOLT11 = `lnbcrt10u1${"q".repeat(120)}`;
export const ADDRESS = "bcrt1qexampleexampleexample";

export const bolt11For = (sats, prefix = "lnbcrt") => `${prefix}${sats * 10}n1${"q".repeat(120)}`;
