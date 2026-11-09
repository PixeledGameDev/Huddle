//! `huddle://` links and launch commands (port of desktop/src/deeplink.js).
//!
//! Any web page can hand the app a huddle:// link, so this accepts only the exact shapes below and nothing else. An invite
//! link never joins anything by itself: it opens the same invite page as a normal link, where joining still needs a click.
use regex::Regex;
use std::sync::LazyLock;
use url::Url;

static INVITE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{6,32}$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Open,
    Invite(String),
}

/// "huddle://invite/CODE" -> Invite, "huddle://open" -> Open, anything else -> None.
pub fn parse_deep_link(arg: &str) -> Option<DeepLink> {
    if arg.len() > 200 {
        return None;
    }
    let raw = arg.trim();
    // The URL parser would quietly drop line breaks and tabs; refuse them instead.
    if raw.chars().any(|c| c <= ' ' || c == '\u{7f}' || c == '\\') {
        return None;
    }
    let u = Url::parse(raw).ok()?;
    if u.scheme() != "huddle" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() || u.query().is_some() || u.fragment().is_some() {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    let parts: Vec<&str> = u.path().split('/').filter(|p| !p.is_empty()).collect();
    match (host.as_str(), parts.as_slice()) {
        ("open", []) => Some(DeepLink::Open),
        ("invite", [code]) if INVITE_CODE.is_match(code) => Some(DeepLink::Invite((*code).to_string())),
        _ => None,
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LaunchArgs {
    pub deep_link: Option<DeepLink>,
    pub quit: bool,
    pub check_updates: bool,
    pub open: bool,
    pub hidden: bool,
}

/// What a launch (or a second launch while the app is running) asks for, from its command-line arguments.
pub fn parse_launch_args<S: AsRef<str>>(argv: &[S]) -> LaunchArgs {
    let mut out = LaunchArgs::default();
    for a in argv {
        let a = a.as_ref();
        match a {
            "--quit" => out.quit = true,
            "--check-updates" => out.check_updates = true,
            "--open" => out.open = true,
            "--hidden" => out.hidden = true,
            _ if a.to_lowercase().starts_with("huddle:") && out.deep_link.is_none() => out.deep_link = parse_deep_link(a),
            _ => {}
        }
    }
    out
}

/// The page of the Huddle server to show for a link, or None.
pub fn invite_path(link: &Option<DeepLink>) -> Option<String> {
    match link {
        Some(DeepLink::Invite(code)) => Some(format!("/invite/{code}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_and_open_links_are_understood() {
        assert_eq!(parse_deep_link("huddle://invite/abcDEF12"), Some(DeepLink::Invite("abcDEF12".into())));
        assert_eq!(parse_deep_link("huddle://open"), Some(DeepLink::Open));
        assert_eq!(parse_deep_link("HUDDLE://OPEN/"), Some(DeepLink::Open));
    }
    #[test]
    fn anything_else_is_ignored() {
        for bad in [
            "huddle://invite/short", "huddle://invite/a/b", "huddle://invite/abc%2Fdef123", "huddle://invite/abcdef12?x=1", "huddle://invite/abcdef12#x",
            "huddle://user@invite/abcdef12", "huddle://invite:80/abcdef12", "https://invite/abcdef12", "huddle://other", "huddle://invite/abcdef\n12", "huddle://invite/abc\tdef12", "huddle://invite\\abcdef12",
            "huddle://invite/abcdef12 --quit",
        ] {
            assert_eq!(parse_deep_link(bad), None, "{bad:?}");
        }
        assert_eq!(parse_deep_link(&format!("huddle://invite/{}", "a".repeat(300))), None);
        // Whitespace around the whole argument is just trimmed (command lines often carry a trailing newline); only inside it is refused.
        assert_eq!(parse_deep_link("  huddle://invite/abcdef12\n"), Some(DeepLink::Invite("abcdef12".into())));
    }
    #[test]
    fn launch_args_are_sorted_out() {
        let a = parse_launch_args(&["huddle.exe", "--check-updates", "huddle://invite/abcdef12", "huddle://invite/zzzzzz99"]);
        assert!(a.check_updates && !a.quit && !a.open);
        assert_eq!(a.deep_link, Some(DeepLink::Invite("abcdef12".into())));
        assert!(parse_launch_args(&["--quit"]).quit);
        assert!(parse_launch_args(&["--hidden"]).hidden);
        assert_eq!(parse_launch_args::<&str>(&[]), LaunchArgs::default());
    }
    #[test]
    fn invite_pages() {
        assert_eq!(invite_path(&Some(DeepLink::Invite("abcdef12".into()))).as_deref(), Some("/invite/abcdef12"));
        assert_eq!(invite_path(&Some(DeepLink::Open)), None);
        assert_eq!(invite_path(&None), None);
    }
}
