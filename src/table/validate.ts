/**
 * Quick checks of typed or pasted values against the column type (spec 4.3), so that
 * obviously wrong cells are marked before saving. Only clear mistakes are reported;
 * the server has the last word on everything else.
 */

const INTEGER = /^(smallint|integer|bigint|int2|int4|int8|oid)$/;
const DECIMAL = /^(numeric|decimal|real|double precision|float4|float8)(\(.*\))?$/;
const BOOLEAN_TEXT = /^(t|f|true|false|y|n|yes|no|on|off|1|0)$/i;
const UUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const LIMITS: Record<string, [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  int2: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  int4: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
  int8: [-9223372036854775808n, 9223372036854775807n],
  oid: [0n, 4294967295n],
};

/** Why `text` is not a valid value of the column, or `null` when it looks fine. */
export function invalidReason(
  text: string,
  typeName: string,
  enumValues: readonly string[] = [],
): string | null {
  const t = text.trim();
  if (INTEGER.test(typeName)) {
    if (!/^[+-]?\d+$/.test(t)) {
      return "整数ではありません";
    }
    const [lo, hi] = LIMITS[typeName] ?? [0n, 0n];
    const n = BigInt(t);
    return n < lo || n > hi ? `${typeName} の範囲を超えています` : null;
  }
  if (DECIMAL.test(typeName)) {
    return NUMBER.test(t) || /^[+-]?(nan|infinity|inf)$/i.test(t) ? null : "数値ではありません";
  }
  if (typeName === "boolean") {
    return BOOLEAN_TEXT.test(t) ? null : "true / false ではありません";
  }
  if (typeName === "uuid") {
    return UUID.test(t) ? null : "UUIDの形式ではありません";
  }
  if (typeName === "json" || typeName === "jsonb") {
    try {
      JSON.parse(text);
      return null;
    } catch {
      return "JSONとして読めません";
    }
  }
  if (typeName === "date") {
    return /^\d{4}-\d{1,2}-\d{1,2}( BC)?$/.test(t) ||
      /^(today|tomorrow|yesterday|infinity|-infinity|epoch|now)$/i.test(t) ||
      // Other DateStyle inputs (01/02/2024, Jan 2 2024) are left to the server.
      !/^\d{4}-/.test(t)
      ? null
      : "日付の形式ではありません";
  }
  if (enumValues.length > 0) {
    return enumValues.includes(text) ? null : `次のいずれかです: ${enumValues.join(", ")}`;
  }
  return null;
}
