// Shows what the main process tells the splash screen: a line of text and, while downloading, a progress bar.
const status = document.getElementById("status");
const bar = document.getElementById("bar");
const fill = document.getElementById("fill");

window.huddleSplash.onStatus(({ text, percent }) => {
  status.textContent = text || "";
  if (typeof percent === "number") {
    bar.classList.add("known");
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  } else {
    bar.classList.remove("known");
    fill.style.width = "";
  }
});
