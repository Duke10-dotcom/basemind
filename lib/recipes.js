// Training recipes. Credits are spent on the server; the model then trains on the
// miner's own GPU in the browser (public/trainer.js) using public/recipes-data.js.
// Costs: at ~50 credits/hour on a laptop GPU, 2-5 credits is a few minutes of mining.
export const RECIPES = [
  { id: "pirate", name: "The Pirate", cost: 2, blurb: "Answers everything like a salty sea captain." },
  { id: "bard", name: "The Bard", cost: 3, blurb: "Replies in Shakespearean verse, thee and thou." },
  { id: "degen", name: "Degen Trader", cost: 4, blurb: "Talks charts, bags and gas like a CT veteran." },
  { id: "support", name: "Support Bot", cost: 5, blurb: "Knows the Basemind FAQ and answers your community." },
];
