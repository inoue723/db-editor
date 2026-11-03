import { expect, test } from "vitest";
import { parseBindings } from "./KeybindingsEditor";
import {
  addBinding,
  conflicts,
  effectiveBindings,
  isCustomized,
  keysFor,
  matchKey,
  removeBinding,
  resetCommand,
} from "./keymap";

const all = () => true;

test("defaults resolve with their conditions", () => {
  const b = effectiveBindings([]);
  expect(keysFor(b, "table.duplicateRow")).toEqual(["mod+d"]);
  expect(matchKey(b, "mod+d", { tab: "table", focus: "grid" }, all)).toEqual({
    kind: "command",
    command: "table.duplicateRow",
  });
  // Not while typing in a field.
  expect(matchKey(b, "mod+d", { tab: "table", focus: "input" }, all)).toBeNull();
  // Only commands that something handles right now.
  expect(matchKey(b, "mod+d", { tab: "table", focus: "grid" }, () => false)).toBeNull();
});

test("user bindings override and remove defaults", () => {
  const b = effectiveBindings([
    { key: "cmd+shift+d", command: "table.duplicateRow" },
    { key: "mod+d", command: "-table.duplicateRow" },
  ]);
  expect(keysFor(b, "table.duplicateRow")).toEqual(["mod+shift+d"]);
  // The rebound key keeps the command's default condition.
  expect(matchKey(b, "mod+shift+d", { tab: "table", focus: "input" }, all)).toBeNull();
  expect(matchKey(b, "mod+shift+d", { tab: "table", focus: "grid" }, all)).toEqual({
    kind: "command",
    command: "table.duplicateRow",
  });
});

test("chord sequences report a prefix first", () => {
  const b = effectiveBindings([]);
  expect(matchKey(b, "mod+k", { focus: "grid" }, all)).toEqual({ kind: "prefix" });
  expect(matchKey(b, "mod+k mod+s", { focus: "grid" }, all)).toEqual({
    kind: "command",
    command: "app.openKeybindings",
  });
});

test("adding a key finds and optionally replaces conflicts", () => {
  const b = effectiveBindings([]);
  const found = conflicts(b, "mod+d", "table.insertRow");
  expect(found.map((x) => x.command)).toEqual(["table.duplicateRow"]);
  const replaced = addBinding([], b, "table.insertRow", "mod+d", true);
  expect(replaced).toEqual([
    { key: "mod+d", command: "-table.duplicateRow" },
    { key: "mod+d", command: "table.insertRow" },
  ]);
  const after = effectiveBindings(replaced);
  expect(keysFor(after, "table.duplicateRow")).toEqual([]);
  expect(isCustomized(replaced, "table.duplicateRow")).toBe(true);
  expect(resetCommand(replaced, "table.duplicateRow")).toEqual([
    { key: "mod+d", command: "table.insertRow" },
  ]);
  const user = after.find((x) => x.user);
  expect(user && removeBinding(replaced, user)).toEqual([
    { key: "mod+d", command: "-table.duplicateRow" },
  ]);
});

test("keybindings.json text is checked before it is saved", () => {
  expect(parseBindings('[{"key":"mod+d","command":"x","when":"focus == grid"}]')).toEqual([
    { key: "mod+d", command: "x", when: "focus == grid" },
  ]);
  expect(parseBindings('{"key":"mod+d"}')).toBeNull();
  expect(parseBindings('[{"key":1,"command":"x"}]')).toBeNull();
});
