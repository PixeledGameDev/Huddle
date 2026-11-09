// The app passes the download page's address in the query string (and only ever an http(s) one).
const link = document.getElementById("get");
const target = new URLSearchParams(location.search).get("download");
if (target && /^https?:\/\//i.test(target)) {
  link.href = target;
} else {
  link.hidden = true;
  document.getElementById("fallback").hidden = false;
}
