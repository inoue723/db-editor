/**
 * `when` clauses of key bindings (spec 5.1): `focus == grid`, `tab == table && !readOnly`.
 *
 * Grammar: `or := and ("||" and)*`, `and := unary ("&&" unary)*`,
 * `unary := "!" unary | "(" or ")" | name (("==" | "!=") value)?`.
 * A bare name is true when its value is truthy. Unknown names are undefined.
 */

export type WhenContext = Record<string, string | boolean | undefined>;

type Token = { kind: "op"; text: string } | { kind: "word"; text: string };

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  const re = /\s*(==|!=|&&|\|\||!|\(|\)|[\w.-]+|'[^']*'|"[^"]*")/y;
  let i = 0;
  while (i < text.length) {
    if (/^\s*$/.test(text.slice(i))) {
      break;
    }
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m?.[1]) {
      return null;
    }
    const t = m[1];
    tokens.push(
      /^[\w.-]/.test(t) || /^['"]/.test(t) ? { kind: "word", text: t } : { kind: "op", text: t },
    );
    i = re.lastIndex;
  }
  return tokens;
}

function literal(word: string): string | boolean {
  if (word === "true") {
    return true;
  }
  if (word === "false") {
    return false;
  }
  return word.replace(/^['"]|['"]$/g, "");
}

/** Evaluates a `when` clause. An empty clause is true; a malformed one is false. */
export function evaluateWhen(when: string | undefined, ctx: WhenContext): boolean {
  if (!when?.trim()) {
    return true;
  }
  const tokens = tokenize(when);
  if (!tokens) {
    return false;
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (text: string) => {
    const t = peek();
    return t?.kind === "op" && t.text === text;
  };

  function unary(): boolean | null {
    if (isOp("!")) {
      pos++;
      const v = unary();
      return v === null ? null : !v;
    }
    if (isOp("(")) {
      pos++;
      const v = or();
      if (!isOp(")")) {
        return null;
      }
      pos++;
      return v;
    }
    const t = peek();
    if (t?.kind !== "word") {
      return null;
    }
    pos++;
    const value = ctx[t.text];
    if (isOp("==") || isOp("!=")) {
      const negate = peek()?.text === "!=";
      pos++;
      const rhs = peek();
      if (rhs?.kind !== "word") {
        return null;
      }
      pos++;
      const equal = value === literal(rhs.text);
      return negate ? !equal : equal;
    }
    return Boolean(value);
  }

  function and(): boolean | null {
    let v = unary();
    while (v !== null && isOp("&&")) {
      pos++;
      const r = unary();
      v = r === null ? null : v && r;
    }
    return v;
  }

  function or(): boolean | null {
    let v = and();
    while (v !== null && isOp("||")) {
      pos++;
      const r = and();
      v = r === null ? null : v || r;
    }
    return v;
  }

  const result = or();
  return result !== null && pos === tokens.length && result;
}
