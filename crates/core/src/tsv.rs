//! Excel-compatible TSV encoding and decoding for clipboard copy and paste.
//!
//! Values containing a tab, newline or double quote are wrapped in double quotes,
//! and embedded double quotes are doubled. Unlike some tools, such characters are
//! never replaced with spaces, so a copy followed by a paste is lossless.

use thiserror::Error;

/// Errors produced while parsing TSV text.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ParseError {
    /// A quoted field was not closed before the end of input.
    #[error("unterminated quoted field starting on line {line}")]
    UnterminatedQuote { line: usize },
}

fn needs_quoting(value: &str) -> bool {
    value.contains(['\t', '\n', '\r', '"'])
}

/// Encodes one cell value.
#[must_use]
pub fn encode_cell(value: &str) -> String {
    if needs_quoting(value) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// Encodes rows of cells as TSV. Every row, including the last, ends with `\n`,
/// as spreadsheet applications do; this keeps rows of empty cells unambiguous.
#[must_use]
pub fn encode<R, C>(rows: R) -> String
where
    R: IntoIterator<Item = C>,
    C: IntoIterator,
    C::Item: AsRef<str>,
{
    rows.into_iter()
        .map(|row| {
            row.into_iter()
                .map(|cell| encode_cell(cell.as_ref()))
                .collect::<Vec<_>>()
                .join("\t")
        })
        .map(|line| line + "\n")
        .collect()
}

/// Parses TSV text into rows of cells.
///
/// Accepts `\n` and `\r\n` line endings. A single trailing line break is ignored,
/// as spreadsheet applications usually append one when copying.
///
/// # Errors
///
/// Returns [`ParseError::UnterminatedQuote`] when a quoted field is not closed.
pub fn parse(text: &str) -> Result<Vec<Vec<String>>, ParseError> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);

    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut chars = text.chars().peekable();
    let mut line = 1;
    let mut at_cell_start = true;

    while let Some(c) = chars.next() {
        match c {
            '"' if at_cell_start => {
                let start_line = line;
                loop {
                    match chars.next() {
                        Some('"') if chars.peek() == Some(&'"') => {
                            chars.next();
                            cell.push('"');
                        }
                        Some('"') => break,
                        Some(other) => {
                            if other == '\n' {
                                line += 1;
                            }
                            cell.push(other);
                        }
                        None => return Err(ParseError::UnterminatedQuote { line: start_line }),
                    }
                }
                at_cell_start = false;
            }
            '\t' => {
                row.push(std::mem::take(&mut cell));
                at_cell_start = true;
            }
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
                line += 1;
                at_cell_start = true;
            }
            other => {
                cell.push(other);
                at_cell_start = false;
            }
        }
    }
    row.push(cell);
    rows.push(row);
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_values_are_not_quoted() {
        assert_eq!(encode_cell("hello"), "hello");
    }

    #[test]
    fn special_characters_are_quoted() {
        assert_eq!(encode_cell("a\tb"), "\"a\tb\"");
        assert_eq!(encode_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn trailing_newline_from_spreadsheets_is_ignored() {
        assert_eq!(parse("a\tb\n").unwrap(), vec![vec!["a", "b"]]);
        assert_eq!(parse("a\tb\r\n").unwrap(), vec![vec!["a", "b"]]);
    }

    #[test]
    fn unterminated_quote_is_an_error() {
        assert_eq!(
            parse("x\n\"open"),
            Err(ParseError::UnterminatedQuote { line: 2 })
        );
    }
}
