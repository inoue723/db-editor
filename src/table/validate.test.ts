import { expect, test } from "vitest";
import { invalidReason } from "./validate";

test("obvious type mistakes are caught before saving", () => {
  expect(invalidReason("12", "integer")).toBeNull();
  expect(invalidReason("1.5", "integer")).not.toBeNull();
  expect(invalidReason("99999", "smallint")).not.toBeNull();
  expect(invalidReason("-1.5e3", "numeric(10,2)")).toBeNull();
  expect(invalidReason("abc", "double precision")).not.toBeNull();
  expect(invalidReason("yes", "boolean")).toBeNull();
  expect(invalidReason("maybe", "boolean")).not.toBeNull();
  expect(invalidReason('{"a":1}', "jsonb")).toBeNull();
  expect(invalidReason("{a:1}", "json")).not.toBeNull();
  expect(invalidReason("2b1f5c7e-0000-4000-8000-000000000000", "uuid")).toBeNull();
  expect(invalidReason("2024-1", "date")).not.toBeNull();
  expect(invalidReason("pro", "plan", ["free", "pro"])).toBeNull();
  expect(invalidReason("gold", "plan", ["free", "pro"])).not.toBeNull();
  expect(invalidReason("anything", "text")).toBeNull();
});
