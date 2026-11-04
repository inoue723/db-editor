import { expect, test } from "vitest";
import { evaluateWhen } from "./when";

test("when clauses compare context values", () => {
  const ctx = { focus: "grid", tab: "table", readOnly: false };
  expect(evaluateWhen(undefined, ctx)).toBe(true);
  expect(evaluateWhen("focus == grid", ctx)).toBe(true);
  expect(evaluateWhen("focus != grid", ctx)).toBe(false);
  expect(evaluateWhen("tab == table && focus != input && focus != editor", ctx)).toBe(true);
  expect(evaluateWhen("focus == editor || tab == table", ctx)).toBe(true);
  expect(evaluateWhen("!readOnly && (focus == 'grid')", ctx)).toBe(true);
  expect(evaluateWhen("readOnly == false", ctx)).toBe(true);
  expect(evaluateWhen("unknownKey", ctx)).toBe(false);
});

test("malformed clauses are false", () => {
  expect(evaluateWhen("focus ==", { focus: "grid" })).toBe(false);
  expect(evaluateWhen("(focus == grid", { focus: "grid" })).toBe(false);
  expect(evaluateWhen("focus == grid grid", { focus: "grid" })).toBe(false);
});
