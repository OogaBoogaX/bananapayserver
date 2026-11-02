// Fireworks, the first thing OBL sells: bought at the hub's stand, and launched on every open page
// at the same moment. A purchase, never a donation. See decisions 0028 and 0029.

export const FIREWORK_CATEGORY = "firework";

// The regions of sky the shows are spread over, numbered 0 to 5 from left to right across the
// arc over the Timechain Sphere, as seen from the island.
export const SLOTS = 6;

// Each firework's price, how many of the sky's slots it fills, and how long it holds them from
// its launch. A show fills `slots` neighbouring slots, starting at its own. A buyer may choose
// that slot. Every page hears who launched it, signed-in buyers are ranked on the stand's
// plaque, and the stand's top launches board counts each firework sold in the last seven days.
export const FIREWORK = {
  items: {
    pop: { sats: 10, slots: 1, holdMs: 4_000 },
    bolt: { sats: 69, slots: 1, holdMs: 5_000 },
    mega: { sats: 100, slots: 1, holdMs: 7_000 },
    show: { sats: 300, slots: 3, holdMs: 12_000 },
  },
  buyers: "signed-in",
  announce: true,
  board: true,
  counts: true,
  slots: SLOTS,
};
