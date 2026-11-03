/** A column as the grid shows it. */
export interface GridColumn {
  name: string;
  /** Type name, shown under the column name; empty when unknown. */
  typeName: string;
  /** Right-aligned. */
  numeric: boolean;
  /** Part of the row key (primary key). */
  key?: boolean;
  /** Target of a foreign key, for example `users`. */
  foreignKey?: string;
}

/** Values in PostgreSQL text format; `null` is SQL NULL. */
export type GridRow = (string | null)[];

const NUMERIC_TYPES =
  /^(smallint|integer|bigint|numeric|decimal|real|double precision|int2|int4|int8|float4|float8|oid|money)\b/;

/** Whether values of a type should be right-aligned. */
export function isNumericType(typeName: string): boolean {
  return NUMERIC_TYPES.test(typeName);
}
