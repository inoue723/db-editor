import { expect, test } from "vitest";
import { matchScore } from "./CommandPalette";
import { focusContext } from "./CommandProvider";

test("palette matching prefers substrings over scattered letters", () => {
  expect(matchScore("dup", "Duplicate Row")).toBeGreaterThan(matchScore("dpr", "Duplicate Row"));
  expect(matchScore("dpr", "Duplicate Row")).toBeGreaterThan(0);
  expect(matchScore("行を複製", "行を複製")).toBeGreaterThan(0);
  expect(matchScore("zzz", "Duplicate Row")).toBe(0);
});

test("focus context tells grid, editor and text fields apart", () => {
  document.body.innerHTML =
    '<div class="gridwrap" tabindex="0"><textarea data-cell-editor></textarea></div>' +
    '<div class="cm-editor"><div contenteditable="true"></div></div><input />';
  const [grid, cell, cm, input] = [
    document.querySelector(".gridwrap"),
    document.querySelector("textarea"),
    document.querySelector("[contenteditable]"),
    document.querySelector("input"),
  ];
  expect(focusContext(grid)).toBe("grid");
  expect(focusContext(cell)).toBe("input");
  expect(focusContext(cm)).toBe("editor");
  expect(focusContext(input)).toBe("input");
  expect(focusContext(document.body)).toBe("other");
});
