// Fireworks, the first thing OBL sells: bought at the hub's stand, and launched on every open page
// at the same moment. A purchase, never a donation. See decisions 0028 and 0029.

export const FIREWORK_CATEGORY = "firework";

// Each firework's price, how many of the sky's slots it fills, and how long it holds them from
// its launch. A show fills `slots` neighbouring slots, starting at its own. Every page hears
// who launched it, and signed-in buyers are ranked on the stand's plaque.
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
};

// The regions of sky the shows are spread over.
export const SLOTS = 6;
