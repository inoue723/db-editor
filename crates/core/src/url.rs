//! Parses `postgres://` connection URLs pasted into the connection dialog.

use serde::{Deserialize, Serialize};

/// Fields read from a connection URL. Missing parts are `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    pub user: Option<String>,
    pub password: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    /// The `sslmode` query parameter as written (`require`, `verify-full`, ...).
    pub ssl_mode: Option<String>,
}

/// Errors from [`parse`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UrlError {
    #[error("the URL must start with postgres:// or postgresql://")]
    Scheme,
    #[error("invalid port: {0}")]
    Port(String),
}

/// Parses `postgres://user:password@host:port/database?sslmode=require`.
///
/// # Errors
///
/// Returns an error for another scheme or a port that is not a number.
pub fn parse(url: &str) -> Result<ParsedUrl, UrlError> {
    let url = url.trim();
    let rest = url
        .strip_prefix("postgresql://")
        .or_else(|| url.strip_prefix("postgres://"))
        .ok_or(UrlError::Scheme)?;

    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };

    let mut parsed = ParsedUrl::default();
    if let Some(userinfo) = userinfo {
        let (user, password) = match userinfo.split_once(':') {
            Some((u, p)) => (u, Some(p)),
            None => (userinfo, None),
        };
        parsed.user = non_empty(decode(user));
        parsed.password = password.map(decode);
    }

    let (host, port) = if let Some(v6) = hostport.strip_prefix('[') {
        match v6.split_once(']') {
            Some((h, p)) => (h, p.strip_prefix(':')),
            None => (v6, None),
        }
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (hostport, None),
        }
    };
    parsed.host = non_empty(decode(host));
    if let Some(port) = port.filter(|p| !p.is_empty()) {
        parsed.port = Some(port.parse().map_err(|_| UrlError::Port(port.to_owned()))?);
    }
    parsed.database = non_empty(decode(path));

    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "sslmode" => parsed.ssl_mode = non_empty(decode(value)),
                "user" if parsed.user.is_none() => parsed.user = non_empty(decode(value)),
                "password" if parsed.password.is_none() => parsed.password = Some(decode(value)),
                "host" if parsed.host.is_none() => parsed.host = non_empty(decode(value)),
                "dbname" if parsed.database.is_none() => {
                    parsed.database = non_empty(decode(value));
                }
                _ => {}
            }
        }
    }
    Ok(parsed)
}

fn non_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// Percent-decodes a URL component. Invalid escapes are kept as they are.
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_url() {
        assert_eq!(
            parse("postgres://app:s%40cret@db.example.com:6432/shop?sslmode=require").unwrap(),
            ParsedUrl {
                user: Some("app".into()),
                password: Some("s@cret".into()),
                host: Some("db.example.com".into()),
                port: Some(6432),
                database: Some("shop".into()),
                ssl_mode: Some("require".into()),
            }
        );
    }

    #[test]
    fn parses_minimal_and_ipv6_urls() {
        assert_eq!(
            parse("postgresql://localhost").unwrap(),
            ParsedUrl {
                host: Some("localhost".into()),
                ..ParsedUrl::default()
            }
        );
        let v6 = parse("postgres://u@[::1]:5433/db").unwrap();
        assert_eq!(v6.host.as_deref(), Some("::1"));
        assert_eq!(v6.port, Some(5433));
    }

    #[test]
    fn rejects_other_schemes_and_bad_ports() {
        assert_eq!(parse("mysql://x"), Err(UrlError::Scheme));
        assert_eq!(
            parse("postgres://h:abc/db"),
            Err(UrlError::Port("abc".into()))
        );
    }
}
