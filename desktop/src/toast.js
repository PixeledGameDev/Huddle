// Draws one Huddle reply popup: who wrote, what they said, and a box to answer without opening Huddle.
const $ = (id) => document.getElementById(id);
const input = $("reply"), send = $("send"), statusEl = $("status"), form = $("form");
let busy = false;

const actionsEl = $("actions");
let hasActions = false;

window.huddleToast.onShow(({ title, body, canReply, actions }) => {
  $("title").textContent = title;
  $("body").textContent = body;
  hasActions = actions.length > 0;
  // A popup with buttons (like "update ready") shows just those; a message popup shows the reply box.
  actionsEl.replaceChildren(...actions.map((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    if (a.primary) b.className = "primary";
    b.addEventListener("click", () => window.huddleToast.action(a.id));
    return b;
  }));
  actionsEl.hidden = !hasActions;
  form.hidden = hasActions || !canReply;
  $("read").hidden = hasActions || !canReply;
  $("open").hidden = hasActions;
  statusEl.textContent = "";
  statusEl.className = "status";
});

const say = (text, cls = "") => { statusEl.textContent = text; statusEl.className = `status ${cls}`; };

input.addEventListener("input", () => { send.disabled = busy || !input.value.trim(); });
// Stay open while typing or pointing at it; go away a few seconds after you stop.
document.body.addEventListener("mouseenter", () => window.huddleToast.hold(true));
document.body.addEventListener("mouseleave", () => { if (document.activeElement !== input || !input.value) window.huddleToast.hold(false); });
input.addEventListener("focus", () => window.huddleToast.hold(true));
input.addEventListener("blur", () => { if (!input.value) window.huddleToast.hold(false); });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value || busy) return;
  busy = true; send.disabled = true; say("Sending…");
  const r = await window.huddleToast.reply(value).catch(() => ({ ok: false, error: "Couldn't send." }));
  busy = false;
  if (r?.ok) { input.value = ""; input.disabled = true; say("Sent ✓", "ok"); }
  else { send.disabled = !input.value.trim(); say(r?.error || "Couldn't send.", "err"); }
});
$("close").addEventListener("click", () => window.huddleToast.close());
$("read").addEventListener("click", () => window.huddleToast.markRead());
$("open").addEventListener("click", () => window.huddleToast.open());
$("body").addEventListener("click", () => { if (!hasActions) window.huddleToast.open(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.huddleToast.close(); });
