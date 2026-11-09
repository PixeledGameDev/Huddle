//! The app's own pages (splash, popups, setup) are built into the program and served over a private address, so they work
//! with no files next to the executable and can't be reached from the web.
use std::borrow::Cow;
use wry::http::{header::CONTENT_TYPE, Request, Response};

pub const SCHEME: &str = "huddleapp";
/// Where WebView2 (Windows) and the other engines put a custom scheme.
pub const BASE: &str = if cfg!(windows) { "http://huddleapp.localhost" } else { "huddleapp://localhost" };

pub const BRIDGE: &str = include_str!("../ui/bridge.js");
pub const ICON_PNG: &[u8] = include_bytes!("../assets/icon.png");
pub const TRAY_PNG: &[u8] = include_bytes!("../assets/tray.png");
pub const TRAY_UNREAD_PNG: &[u8] = include_bytes!("../assets/tray-unread.png");

pub fn page_url(name: &str) -> String {
    format!("{BASE}/{name}")
}

/// Is this one of the app's own pages?
pub fn is_local(url: &str) -> bool {
    url.strip_prefix(BASE).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// Is `url` this exact local page (ignoring any query string)?
pub fn is_page(url: &str, name: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("");
    path == page_url(name)
}

fn asset(path: &str) -> Option<(&'static str, Cow<'static, [u8]>)> {
    let text = |s: &'static str| Some(("text/html; charset=utf-8", Cow::Borrowed(s.as_bytes())));
    let js = |s: &'static str| Some(("text/javascript; charset=utf-8", Cow::Borrowed(s.as_bytes())));
    match path {
        "splash.html" => text(include_str!("../ui/splash.html")),
        "dialog.html" => text(include_str!("../ui/dialog.html")),
        "toast.html" => text(include_str!("../ui/toast.html")),
        "setup.html" => text(include_str!("../ui/setup.html")),
        "common.js" => js(include_str!("../ui/common.js")),
        "splash.js" => js(include_str!("../ui/splash.js")),
        "dialog.js" => js(include_str!("../ui/dialog.js")),
        "toast.js" => js(include_str!("../ui/toast.js")),
        "setup.js" => js(include_str!("../ui/setup.js")),
        "icon.png" => Some(("image/png", Cow::Borrowed(ICON_PNG))),
        _ => None,
    }
}

/// The handler behind the private address.
pub fn serve(req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = req.uri().path().trim_start_matches('/');
    match asset(path) {
        Some((mime, body)) => Response::builder().header(CONTENT_TYPE, mime).header("Cache-Control", "no-store").body(body).unwrap(),
        None => Response::builder().status(404).body(Cow::Borrowed(&b"Not found"[..])).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_addresses_are_local() {
        assert!(is_local(&page_url("setup.html")));
        assert!(is_local(&format!("{BASE}/toast.html?x=1")));
        assert!(!is_local(&format!("{BASE}.evil.com/setup.html")));
        assert!(!is_local("https://huddle.example.com/setup.html"));
    }
    #[test]
    fn pages_match_exactly() {
        assert!(is_page(&format!("{}?failed=1", page_url("setup.html")), "setup.html"));
        assert!(!is_page(&page_url("setup.html.evil"), "setup.html"));
        assert!(!is_page(&page_url("toast.html"), "setup.html"));
    }
    #[test]
    fn every_page_script_and_icon_is_served() {
        for p in ["splash.html", "dialog.html", "toast.html", "setup.html", "common.js", "splash.js", "dialog.js", "toast.js", "setup.js", "icon.png"] {
            assert!(asset(p).is_some(), "{p}");
        }
        assert!(asset("../Cargo.toml").is_none() && asset("bridge.js").is_none());
    }
}
