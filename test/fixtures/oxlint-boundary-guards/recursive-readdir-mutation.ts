import fs from "node:fs";
const assigned = { recursive: false };
assigned.recursive = true;
fs.readdirSync("root", assigned);
const merged = {};
Object.assign(merged, { recursive: true });
fs.readdirSync("root", merged);
const escaped = { recursive: false };
change(escaped);
fs.readdirSync("root", escaped);
const original = { recursive: false };
const alias = original;
alias.recursive = true;
fs.readdirSync("root", original);
const removed = { recursive: false };
delete removed.recursive;
fs.readdirSync("root", removed);
const published = { recursive: false };
const container = { published };
fs.readdirSync("root", published);
const stable = { recursive: false };
fs.readdirSync("root", stable);
fs.readdirSync("root", stable);
function onRead() {}
fs.readdir("root", onRead);
const callback = () => {};
fs.readdir("root", callback);
const callbackAlias = onRead;
fs.readdir("root", callbackAlias);
declare function change(value: unknown): void;
void container;

const delayed = { recursive: false };
const delayedAlias = delayed;
Object.assign(delayed, { recursive: true });
fs.readdirSync("root", delayedAlias);
export const exposed = { recursive: false };
fs.readdirSync("root", exposed);
const captured = { recursive: false };
mutateCaptured();
fs.readdirSync("root", captured);
function mutateCaptured() {
  change(captured);
}
