// Draws one Huddle popup: a message, optional detail, and buttons. Enter picks the default, Escape the cancel button.
const $ = (id) => document.getElementById(id);

window.huddleDialog.onShow(({ type, message, detail, buttons, defaultId, cancelId }) => {
  $("msg").textContent = message;
  if (detail) { $("detail").textContent = detail; $("detail").hidden = false; }
  if (type === "warning") { const ico = $("ico"); ico.className = "ico warn"; ico.textContent = "!"; }
  const actions = $("actions");
  buttons.forEach((label, i) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (i === defaultId) b.className = "primary";
    b.addEventListener("click", () => window.huddleDialog.choose(i));
    actions.appendChild(b);
  });
  actions.children[defaultId]?.focus();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.huddleDialog.choose(cancelId);
    else if (e.key === "Enter" && document.activeElement?.tagName !== "BUTTON") window.huddleDialog.choose(defaultId);
  });
  // The window is sized to fit what it holds.
  window.huddleDialog.resize(Math.ceil($("card").getBoundingClientRect().height) + 28);
});
