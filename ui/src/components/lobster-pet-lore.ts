import { expectDefined } from "@openclaw/normalization-core";
import type { LobsterPetPaletteId } from "./lobster-pet-contract.ts";

type LobsterPaletteLore = {
  name?: string;
  flavor: string;
  hint: string;
};

// Keep legacy random-name slots stable. Dedicated character discoveries are
// keyed by palette id, not these older visitor names.
const PET_NAMES = [
  "Pinchy",
  "Barnaby",
  "Thermidor",
  "Clawdette",
  "Sheldon",
  "Scuttles",
  "Bisque",
  "Crusty",
  "Snips",
  "Bubbles",
  "Clawdia",
  "Ferdinand",
  "Maple",
  "Pearl",
  "Biscuit",
  "Captain",
  "Ziggy",
  "Noodle",
  "Waffles",
  "Pippin",
  "Squirt",
  "Chip",
  "Clementine",
  "Moss",
] as const;

export function lobsterPaletteName(paletteId: LobsterPetPaletteId): string {
  return LOBSTER_PALETTE_LORE[paletteId]?.name ?? paletteId;
}

export function lobsterRandomName(seed: number): string {
  return expectDefined(
    PET_NAMES[(seed >>> 3) % PET_NAMES.length],
    "lobster pet name catalog entry",
  );
}

// Like pet names and bottle fortunes, Lobsterdex lore is an English-only
// easter-egg channel rather than product UI copy.
export const LOBSTER_PALETTE_LORE: Record<LobsterPetPaletteId, LobsterPaletteLore> = {
  crimson: {
    flavor: "The classic red, first in every tide pool.",
    hint: "Where every story starts.",
  },
  blue: { name: "Blueberry", flavor: "1 in 2 million, and knows it.", hint: "One in two million." },
  gold: { name: "Goldie", flavor: "1 in 30 million karats.", hint: "Worth its weight." },
  lumen: {
    name: "Glimmer",
    flavor: "Brings its own night lights.",
    hint: "Glows where it's darkest.",
  },
  magma: { name: "Ember", flavor: "Fresh from the vent, still cooling.", hint: "Runs hot." },
  oilslick: {
    name: "Slick",
    flavor: "Black shell, rainbow finish.",
    hint: "Spilled, not stirred.",
  },
  aurora: {
    name: "Borealis",
    flavor: "Northern lights, southern claws.",
    hint: "Best seen on clear nights.",
  },
  nebula: {
    name: "Cosmo",
    flavor: "Not from any ocean on this planet.",
    hint: "Came from very far away.",
  },
  banana: { name: "Peel", flavor: "Banana. For scale.", hint: "For scale." },
  mood: {
    name: "Ringo",
    flavor: "Wears whatever color you're feeling.",
    hint: "Matches your vibe.",
  },
  bee: { name: "Buzz", flavor: "Technically not a bee.", hint: "Do not tell the bees." },
  rubberduck: { name: "Debuggy", flavor: "Listens to your bugs. Judges silently.", hint: "Quack." },
  watermelon: { name: "Pips", flavor: "Contains 6% lobster.", hint: "Ripe when thumped." },
  clawnstantine: {
    name: "Clawnstantine",
    flavor: "Built an empire. Still rules from the ledge.",
    hint: "All tides lead here.",
  },
  clawiestardust: {
    name: "Clawie Stardust",
    flavor: "Changes shells. Never changes style.",
    hint: "Something electric washed ashore.",
  },
  taylorpinch: {
    name: "Taylor Pinch",
    flavor: "Turns every tide into an era.",
    hint: "Someone is shaking off the sand.",
  },
  clawtoodeetoo: {
    name: "Clawtoo Deetoo",
    flavor: "Speaks fluent beep. Fixes things anyway.",
    hint: "A resourceful little droid.",
  },
  leonardodepinchy: {
    name: "Leonardo DaPinchy",
    flavor: "Every shell is a canvas.",
    hint: "A little Renaissance is washing ashore.",
  },
  shellvis: {
    name: "Shellvis",
    flavor: "The king of rock and claw.",
    hint: "Someone brought blue suede claws.",
  },
  alexandergrahamshell: {
    name: "Alexander Graham Shell",
    flavor: "Good ideas ring a bell.",
    hint: "A familiar ringing from the shore.",
  },
  clawtron: { name: "Clawtron", flavor: "60% rivets, 40% love.", hint: "Beep boop snip." },
  selene: {
    name: "Selene",
    flavor: "Carries the current moon on its belly.",
    hint: "Waxes and wanes.",
  },
  geode: { name: "Amethyst", flavor: "Rock outside, amethyst inside.", hint: "Crack the surface." },
  ghost: {
    name: "Boo",
    flavor: "1 in 100 million, barely there.",
    hint: "You'd walk right past it.",
  },
  glass: {
    name: "Prism",
    flavor: "Fully transparent. Nothing to hide.",
    hint: "Easy to miss, hard to forget.",
  },
  split: { name: "Picasso", flavor: "Two lobsters, one shell.", hint: "Can't pick a side." },
  sourdough: {
    name: "Boule",
    flavor: "Started from a starter. 24-hour proof.",
    hint: "Still proofing.",
  },
  zombie: { name: "Shambles", flavor: "Slightly used. Still friendly.", hint: "It's been better." },
  plush: { name: "Buttons", flavor: "Machine washable. Air dry only.", hint: "Soft to the touch." },
  balloon: { name: "Squeaky", flavor: "Do not pop.", hint: "Handle with care." },
  cottoncandy: {
    name: "Taffy",
    flavor: "Pastel, like the famous Maine catch.",
    hint: "Sweeter than it looks.",
  },
  cryptid: {
    name: "Nessie",
    flavor: "Every photo comes out blurry.",
    hint: "Sightings unconfirmed.",
  },
  flatpack: { name: "Skaldjur", flavor: "Some assembly required.", hint: "Missing one screw." },
  tinfoil: { name: "Mulder", flavor: "The tide is a psyop.", hint: "They know." },
  actual: {
    name: "Homarus",
    flavor: "An actual lobster. Unsettling, honestly.",
    hint: "Anatomically correct.",
  },
  disco: { name: "Boogie", flavor: "Born under a mirror ball.", hint: "The night is still young." },
  chimera: { name: "Frankie", flavor: "Borrowed parts. No refunds.", hint: "Something's off." },
  blueprint: {
    name: "Prototype",
    flavor: "Final hardware pending approval.",
    hint: "Still on the drawing board.",
  },
  phosphor: {
    name: "TTY",
    flavor: "80 columns, 24 rows, one lobster.",
    hint: "Hums at sixty hertz.",
  },
  ascii: { name: "Figlet", flavor: "Renders anywhere. Even over SSH.", hint: "chmod +x" },
  portal: { name: "Warp", flavor: "Arrives before it leaves.", hint: "Mind the gap." },
  notexture: { name: "Magenta", flavor: "Texture not found.", hint: "404." },
  loading: { name: "Spinner", flavor: "Still loading. Any second now.", hint: "…" },
  eclipse: { name: "Umbra", flavor: "Do not look directly at it.", hint: "Once in a blue moon." },
  heisenbug: {
    name: "Segfault",
    flavor: "Only renders right when nobody's watching.",
    hint: "Cannot be reproduced.",
  },
  invisible: {
    name: "Nobody",
    flavor: "It's right there. Look closer.",
    hint: "Trust me, it exists.",
  },
  pixel: { name: "Sprite", flavor: "Rendered in 1987. Still runs.", hint: "Insert coin." },
  retro: {
    name: "OG",
    flavor: "The original: big claw, no apologies.",
    hint: "The one that started it all.",
  },
  goldenretro: { name: "24K", flavor: "One in a generation.", hint: "Worth the wait." },
};
