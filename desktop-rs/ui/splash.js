// Shows what the app tells the splash screen: a line of text and, while downloading, a progress bar.
const status = document.getElementById("status");
const bar = document.getElementById("bar");
const fill = document.getElementById("fill");
const version = document.getElementById("version");

window.hd.on("splash:status", (s) => {
  const text = typeof s?.text === "string" ? s.text.slice(0, 120) : "";
  const v = typeof s?.version === "string" ? s.version.slice(0, 20) : "";
  status.textContent = text;
  if (v) version.textContent = `Version ${v}`;
  if (Number.isFinite(s?.percent)) {
    bar.classList.add("known");
    fill.style.width = `${Math.max(0, Math.min(100, s.percent))}%`;
  } else {
    bar.classList.remove("known");
    fill.style.width = "";
  }
});
window.hd.send("splash:ready");
