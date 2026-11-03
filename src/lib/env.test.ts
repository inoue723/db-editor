import { expect, test } from "vitest";
import { relativeTime } from "./env";

const now = Date.UTC(2026, 0, 10, 12);
const ago = (minutes: number) => now - minutes * 60_000;

test("relative time of the last connection", () => {
  expect(relativeTime(null, now)).toBe("未接続");
  expect(relativeTime(ago(0.5), now)).toBe("たった今");
  expect(relativeTime(ago(5), now)).toBe("5分前");
  expect(relativeTime(ago(180), now)).toBe("3時間前");
  expect(relativeTime(ago(24 * 60), now)).toBe("昨日");
  expect(relativeTime(ago(3 * 24 * 60), now)).toBe("3日前");
  expect(relativeTime(ago(21 * 24 * 60), now)).toBe("3週間前");
});
