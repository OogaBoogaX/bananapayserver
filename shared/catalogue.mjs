// Everything OBL sells, by category. Each category belongs to the OBL experience that sells it,
// and lists its items and their prices in a module of its own, kept here so the server sets every
// price. Selling something new is that module and a line below: the page's call, the invoice, the
// record in D1 and the messages to pages are the same for everything sold. See decision 0028.

import { FIREWORK, FIREWORK_CATEGORY } from "./firework.mjs";

// category → { items: { item: { sats, … } }, buyers, announce, board, counts, slots? }:
// - items, each with its price in sats, and anything else its experience needs;
// - buyers, who may buy unless the deployment's <CATEGORY>_BUYERS setting says otherwise:
//   "signed-in", donors signed in on OBL only, or "everyone";
// - announce, whether every page hears the buyer's login with the purchase;
// - board, whether signed-in buyers are ranked by the sats they have spent in it;
// - counts, whether every page hears how many of each item sold in the last seven days;
// - slots, only for a category whose items fill neighbouring slots, such as fireworks in the
//   sky's: how many there are. A buyer may then choose the first slot an item fills, and each
//   item says how many it fills, one unless it says otherwise.
export const CATALOGUE = {
  [FIREWORK_CATEGORY]: FIREWORK,
};

export const BUYERS = ["signed-in", "everyone"];

// Category and item names, as D1's purchase_items checks them.
export const CATEGORY_NAME = /^[a-z0-9-]{1,32}$/;
export const ITEM_NAME = /^[a-z0-9-]{1,64}$/;

// How many things this page load has bought, counting this one, and a coarse count of the
// purchases this browser made before. Neither identifies anyone.
export const NTH_MAX = 999;
export const BEFORE = ["none", "1", "2-5", "6+"];

export const isNth = (nth) => Number.isSafeInteger(nth) && nth >= 1 && nth <= NTH_MAX;

// Whether a buyer may ask for an item to start at this slot: only in a category with slots, and
// only where all the item's neighbouring slots fit.
export const isSlot = (category, item, slot) => {
  const room = CATALOGUE[category]?.slots;
  const fills = itemOf(category, item)?.slots ?? 1;
  return Number.isSafeInteger(room) && Number.isSafeInteger(slot) && slot >= 0 && slot + fills <= room;
};

// An item on sale, or null.
export const itemOf = (category, item) =>
  typeof category === "string" && Object.hasOwn(CATALOGUE, category) &&
  typeof item === "string" && Object.hasOwn(CATALOGUE[category].items, item)
    ? CATALOGUE[category].items[item] : null;

// The deployment setting that can change who may buy in a category: FIREWORK_BUYERS for
// firework.
export const buyersSetting = (category) => `${category.toUpperCase().replaceAll("-", "_")}_BUYERS`;

export const pricesOf = (category) =>
  Object.fromEntries(Object.entries(CATALOGUE[category].items).map(([item, { sats }]) => [item, sats]));

// What every page receives when something is paid for: id is the BTCPay invoice id, at the
// server's clock as the message goes out, in milliseconds. login is the buyer's GitHub login
// where the category announces its buyers, and null otherwise. A category may add fields of its
// own, as fireworks add when every page launches one.
export const purchaseMessage = ({ id, category, item, at, login }, extra = {}) =>
  ({ type: "purchase", id, category, item, quantity: 1, at, login: login ?? null, ...extra });

// How many of each item in a category were paid for since `since`, the start of the earliest
// hour of the last `days` days, anyone's purchases alike. Every item for sale is listed, at 0
// when none sold.
export const purchaseCountsMessage = (category, { days, since }, rows) => ({
  type: "purchaseCounts",
  category,
  days,
  since,
  items: {
    ...Object.fromEntries(Object.keys(CATALOGUE[category]?.items ?? {}).map((item) => [item, 0])),
    ...Object.fromEntries(rows.map(({ item, paid }) => [item, paid])),
  },
});

// A category's leaderboard: signed-in buyers by the sats they have spent in it.
export const purchaseBoardMessage = (category, rows) =>
  ({ type: "purchaseBoard", category, entries: rows.map(({ login, quantity, sats }) => ({ login, quantity, sats })) });
