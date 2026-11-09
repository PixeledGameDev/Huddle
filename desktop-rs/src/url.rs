//! Server-address handling and link safety.
use regex::Regex;
use std::sync::LazyLock;
use url::Url;

static HAS_SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").unwrap());

/// Turns what someone typed into the address of their Huddle server, or returns `None`.
/// https is required, except for this computer (localhost / 127.0.0.1 / [::1]) where plain http is fine for development.
/// Only the origin is kept, so pasting a link to a channel or invite still works.
pub fn normalize_server_url(input: &str) -> Option<String> {
    let mut text = input.trim().to_string();
    if text.is_empty() || text.chars().count() > 300 {
        return None;
    }
    if !HAS_SCHEME.is_match(&text) {
        text = format!("https://{text}");
    }
    let u = Url::parse(&text).ok()?;
    let host = u.host_str()?.to_string();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    if u.scheme() != "https" && !(u.scheme() == "http" && local) {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    if !local && !host.contains('.') {
        return None; // a bare word like "huddle" isn't a public address
    }
    Some(u.origin().ascii_serialization())
}

/// Is `url` on the same site as `origin`?
pub fn same_origin(url: &str, origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return false };
    match (Url::parse(url), Url::parse(origin)) {
        (Ok(a), Ok(b)) => a.origin().is_tuple() && a.origin() == b.origin(),
        _ => false,
    }
}

/// http(s) links may be handed to the system browser; nothing else (file:, javascript:, custom schemes) ever is.
pub fn is_safe_external(url: &str) -> bool {
    Url::parse(url).map(|u| matches!(u.scheme(), "http" | "https")).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_are_cleaned_up() {
        assert_eq!(normalize_server_url("huddle.example.com").as_deref(), Some("https://huddle.example.com"));
        assert_eq!(normalize_server_url("  https://huddle.example.com/invite/abc?x=1  ").as_deref(), Some("https://huddle.example.com"));
        assert_eq!(normalize_server_url("https://huddle.onrender.com:8443/").as_deref(), Some("https://huddle.onrender.com:8443"));
    }
    #[test]
    fn plain_http_is_only_for_this_computer() {
        assert_eq!(normalize_server_url("http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(normalize_server_url("http://127.0.0.1:3000/x").as_deref(), Some("http://127.0.0.1:3000"));
        assert_eq!(normalize_server_url("http://huddle.example.com"), None);
    }
    #[test]
    fn junk_and_risky_addresses_are_refused() {
        let long = format!("https://{}.com", "a".repeat(400));
        for bad in ["", "   ", "huddle", "javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "https://user:pw@example.com", long.as_str()] {
            assert_eq!(normalize_server_url(bad), None, "{bad}");
        }
    }
    #[test]
    fn same_origin_check() {
        assert!(same_origin("https://huddle.example.com/invite/x", Some("https://huddle.example.com")));
        assert!(!same_origin("https://huddle.example.com.evil.com/", Some("https://huddle.example.com")));
        assert!(!same_origin("http://huddle.example.com/", Some("https://huddle.example.com")));
        assert!(!same_origin("https://huddle.example.com/", None));
        assert!(!same_origin("not a url", Some("https://huddle.example.com")));
    }
    #[test]
    fn only_web_links_go_to_the_system_browser() {
        assert!(is_safe_external("https://example.com/a"));
        assert!(is_safe_external("http://example.com"));
        for bad in ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "smb://host/share", "ms-msdt:/id", "nonsense"] {
            assert!(!is_safe_external(bad), "{bad}");
        }
    }
}
