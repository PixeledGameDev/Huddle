// Draws one Huddle reply popup: who wrote, what they said, and a box to answer without opening Huddle.
const $ = (id) => document.getElementById(id);
const input = $("reply"), send = $("send"), statusEl = $("status"), form = $("form");
const actionsEl = $("actions");
let busy = false;
let hasActions = false;

window.hd.on("toast:show", (t) => {
  const actions = Array.isArray(t?.actions) ? t.actions.slice(0, 3) : [];
  $("title").textContent = String(t?.title ?? "").slice(0, 100);
  $("body").textContent = String(t?.body ?? "").slice(0, 250);
  hasActions = actions.length > 0;
  // A popup with buttons (like "update ready") shows just those; a message popup shows the reply box.
  actionsEl.replaceChildren(...actions.map((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(a.label ?? "").slice(0, 24);
    if (a.primary) b.className = "primary";
    b.addEventListener("click", () => window.hd.send("toast:action", String(a.id ?? "").slice(0, 20)));
    return b;
  }));
  actionsEl.hidden = !hasActions;
  form.hidden = hasActions || !t?.canReply;
  $("read").hidden = hasActions || !t?.canReply;
  $("open").hidden = hasActions;
  statusEl.textContent = "";
  statusEl.className = "status";
});

const say = (text, cls = "") => { statusEl.textContent = text; statusEl.className = `status ${cls}`; };
const hold = (on) => window.hd.send("toast:hold", !!on);

input.addEventListener("input", () => { send.disabled = busy || !input.value.trim(); });
// Stay open while typing or pointing at it; go away a few seconds after you stop.
document.body.addEventListener("mouseenter", () => hold(true));
document.body.addEventListener("mouseleave", () => { if (document.activeElement !== input || !input.value) hold(false); });
input.addEventListener("focus", () => hold(true));
input.addEventListener("blur", () => { if (!input.value) hold(false); });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value || busy) return;
  busy = true; send.disabled = true; say("Sending…");
  const r = await window.hd.invoke("toast:reply", value.slice(0, 2000)).catch(() => ({ ok: false, error: "Couldn't send." }));
  busy = false;
  if (r?.ok) { input.value = ""; input.disabled = true; say("Sent", "ok"); }
  else { send.disabled = !input.value.trim(); say(r?.error || "Couldn't send.", "err"); }
});
$("close").addEventListener("click", () => window.hd.send("toast:close"));
$("read").addEventListener("click", () => window.hd.send("toast:markread"));
$("open").addEventListener("click", () => window.hd.send("toast:open"));
$("body").addEventListener("click", () => { if (!hasActions) window.hd.send("toast:open"); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.hd.send("toast:close"); });
window.hd.send("toast:ready");
