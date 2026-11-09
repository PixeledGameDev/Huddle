// Draws one Huddle popup: a message, optional detail, and buttons. Enter picks the default, Escape the cancel button.
const $ = (id) => document.getElementById(id);

window.hd.on("dialog:show", ({ type, message, detail, buttons, defaultId, cancelId }) => {
  $("msg").textContent = message;
  if (detail) { $("detail").textContent = detail; $("detail").hidden = false; }
  if (type === "warning") { const ico = $("ico"); ico.className = "ico warn"; ico.textContent = "!"; }
  const actions = $("actions");
  buttons.forEach((label, i) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (i === defaultId) b.className = "primary";
    b.addEventListener("click", () => window.hd.send("dialog:choose", i));
    actions.appendChild(b);
  });
  actions.children[defaultId]?.focus();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.hd.send("dialog:choose", cancelId);
    else if (e.key === "Enter" && document.activeElement?.tagName !== "BUTTON") window.hd.send("dialog:choose", defaultId);
  });
  // The window is sized to fit what it holds.
  window.hd.send("dialog:size", Math.ceil($("card").getBoundingClientRect().height) + 28);
});
window.hd.send("dialog:ready");
