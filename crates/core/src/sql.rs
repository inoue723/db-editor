//! SQL text helpers: quoting and splitting a script into statements.
//!
//! The splitter understands enough of the PostgreSQL lexer to find statement
//! boundaries: single-quoted strings (including `E'...'` escapes), double-quoted
//! identifiers, dollar-quoted bodies, `--` line comments and nested `/* */` comments.

use std::ops::Range;

/// Quotes an identifier (`"name"`), doubling embedded double quotes.
#[must_use]
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quotes a qualified name such as `"public"."users"`.
#[must_use]
pub fn quote_qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

/// Quotes a string literal (`'it''s'`). Backslashes are left as they are, which is
/// correct with `standard_conforming_strings = on` (the default since PostgreSQL 9.1).
#[must_use]
pub fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Splits a script into statements and returns their byte ranges.
///
/// Each range covers the statement text without surrounding whitespace and without
/// the terminating semicolon. Leading comments are trimmed from the range, so a
/// statement preceded by `-- note` starts at its first keyword. Ranges that would
/// contain only comments or whitespace are dropped.
#[must_use]
pub fn split_statements(sql: &str) -> Vec<Range<usize>> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    // Start of the current statement's first significant token.
    let mut start: Option<usize> = None;
    // End of the last significant token.
    let mut end = 0;
    let mut i = 0;
    let mut paren_depth: usize = 0;

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = skip_line_comment(bytes, i);
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = skip_block_comment(bytes, i);
                continue;
            }
            b';' if paren_depth == 0 => {
                if let Some(s) = start.take() {
                    out.push(s..end);
                }
                i += 1;
                continue;
            }
            c if c.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            _ => {}
        }

        let token_start = i;
        start.get_or_insert(token_start);
        i = match c {
            b'\'' => skip_quoted(bytes, i, b'\'', is_escape_string(bytes, i)),
            b'"' => skip_quoted(bytes, i, b'"', false),
            b'$' => skip_dollar(bytes, i).unwrap_or(i + 1),
            b'(' => {
                paren_depth += 1;
                i + 1
            }
            b')' => {
                paren_depth = paren_depth.saturating_sub(1);
                i + 1
            }
            _ => next_char_boundary(sql, i),
        };
        end = i;
    }
    if let Some(s) = start {
        out.push(s..end);
    }
    out
}

/// Returns the index of the statement that the cursor (a byte offset) belongs to.
///
/// A cursor inside a statement, or after it on the same stretch before the next
/// statement starts, belongs to that statement. A cursor before the first statement
/// belongs to the first one.
#[must_use]
pub fn statement_at(ranges: &[Range<usize>], cursor: usize) -> Option<usize> {
    if ranges.is_empty() {
        return None;
    }
    let after = ranges.iter().rposition(|r| r.start <= cursor);
    Some(after.unwrap_or(0))
}

/// Returns the first keyword of a statement in upper case (`SELECT`, `BEGIN`, ...).
#[must_use]
pub fn first_keyword(statement: &str) -> String {
    let trimmed = strip_leading_comments(statement);
    trimmed
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect::<String>()
        .to_ascii_uppercase()
}

fn strip_leading_comments(s: &str) -> &str {
    let mut s = s.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if s.starts_with("/*") {
            let end = skip_block_comment(s.as_bytes(), 0);
            s = s.get(end..).unwrap_or("").trim_start();
        } else {
            return s;
        }
    }
}

fn next_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

fn skip_line_comment(bytes: &[u8], i: usize) -> usize {
    bytes[i..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(bytes.len(), |p| i + p + 1)
}

fn skip_block_comment(bytes: &[u8], i: usize) -> usize {
    let mut depth = 0usize;
    let mut j = i;
    while j < bytes.len() {
        if bytes[j] == b'/' && bytes.get(j + 1) == Some(&b'*') {
            depth += 1;
            j += 2;
        } else if bytes[j] == b'*' && bytes.get(j + 1) == Some(&b'/') {
            depth -= 1;
            j += 2;
            if depth == 0 {
                return j;
            }
        } else {
            j += 1;
        }
    }
    bytes.len()
}

fn is_escape_string(bytes: &[u8], quote: usize) -> bool {
    quote > 0
        && matches!(bytes[quote - 1], b'e' | b'E')
        && (quote < 2 || !is_ident_byte(bytes[quote - 2]))
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// Skips a quoted token starting at `i` and returns the index after its closing quote.
fn skip_quoted(bytes: &[u8], i: usize, quote: u8, backslash_escapes: bool) -> usize {
    let mut j = i + 1;
    while j < bytes.len() {
        let b = bytes[j];
        if backslash_escapes && b == b'\\' {
            j += 2;
        } else if b == quote {
            if bytes.get(j + 1) == Some(&quote) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    bytes.len()
}

/// Skips a dollar-quoted body (`$$...$$` or `$tag$...$tag$`). Returns `None` when the
/// `$` does not open one (for example a positional parameter such as `$1`).
fn skip_dollar(bytes: &[u8], i: usize) -> Option<usize> {
    if i > 0 && is_ident_byte(bytes[i - 1]) {
        return None;
    }
    let mut j = i + 1;
    while j < bytes.len() && bytes[j] != b'$' {
        let b = bytes[j];
        let valid = if j == i + 1 {
            b.is_ascii_alphabetic() || b == b'_' || b >= 0x80
        } else {
            is_ident_byte(b)
        };
        if !valid {
            return None;
        }
        j += 1;
    }
    if j >= bytes.len() {
        return None;
    }
    let tag = &bytes[i..=j];
    let body_start = j + 1;
    let close = bytes[body_start..]
        .windows(tag.len())
        .position(|w| w == tag)
        .map_or(bytes.len(), |p| body_start + p + tag.len());
    Some(close)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(sql: &str) -> Vec<&str> {
        split_statements(sql).into_iter().map(|r| &sql[r]).collect()
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_literal("it's"), "'it''s'");
        assert_eq!(quote_qualified("public", "users"), "\"public\".\"users\"");
    }

    #[test]
    fn splits_simple_statements() {
        assert_eq!(
            split("select 1; select 2;\n\nselect 3"),
            vec!["select 1", "select 2", "select 3"]
        );
    }

    #[test]
    fn ignores_semicolons_in_strings_comments_and_bodies() {
        let sql = "-- a; comment\nselect ';' as \"x;y\" /* ; */ ;\n\
                   create function f() returns int as $body$ select 1; $body$ language sql;\n\
                   select E'it\\'s;' , $$;$$";
        assert_eq!(
            split(sql),
            vec![
                "select ';' as \"x;y\"",
                "create function f() returns int as $body$ select 1; $body$ language sql",
                "select E'it\\'s;' , $$;$$",
            ]
        );
    }

    #[test]
    fn positional_parameters_are_not_dollar_quotes() {
        assert_eq!(
            split("prepare p as select $1; execute p(1)"),
            vec!["prepare p as select $1", "execute p(1)"]
        );
    }

    #[test]
    fn comment_only_input_has_no_statements() {
        assert!(split_statements("-- nothing\n/* here */ ;; ").is_empty());
    }

    #[test]
    fn multibyte_text_keeps_char_boundaries() {
        assert_eq!(
            split("select '日本'; select 名前 from t"),
            vec!["select '日本'", "select 名前 from t"]
        );
    }

    #[test]
    fn cursor_picks_the_statement() {
        let sql = "select 1;\nselect 2;\n";
        let ranges = split_statements(sql);
        assert_eq!(statement_at(&ranges, 0), Some(0));
        assert_eq!(statement_at(&ranges, 9), Some(0));
        assert_eq!(statement_at(&ranges, 10), Some(1));
        assert_eq!(statement_at(&ranges, sql.len()), Some(1));
        assert_eq!(statement_at(&[], 0), None);
    }

    #[test]
    fn first_keyword_skips_comments() {
        assert_eq!(first_keyword("-- hi\n/* x */ begin;"), "BEGIN");
        assert_eq!(first_keyword("  select 1"), "SELECT");
    }
}
