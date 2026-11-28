// The kinds of cultural event, and the limits shared by the AI answer checker, the editor and the pages.
export const CATEGORIES = [
  ["fest", "Fest"], ["dance", "Dance"], ["music", "Music"], ["drama", "Drama and theatre"], ["literary", "Literary and quiz"],
  ["art", "Art and craft"], ["fashion", "Fashion"], ["photography", "Photography and film"], ["other", "Cultural"],
];
export const categoryLabel = (v) => CATEGORIES.find(([k]) => k === v)?.[1] || "Cultural";

export const MAX_ITEMS = 30;                   // programme entries
export const ITEM_LIMITS = { title: 120, venue: 120, fee: 80, prize: 120, note: 160 };
// The database refuses a details column over 60,000 bytes; stay well under it.
export const MAX_DETAILS_BYTES = 45_000;
export const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
