const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const failed = params.get("failed"); // set when the server couldn't be reached

(async () => {
  const current = await window.huddleSetup.current();
  if (failed) {
    $("title").textContent = "Can't reach Huddle";
    $("lead").textContent = `Couldn't connect to ${current || "the server"}. Check your internet connection, or the address.`;
    $("form").hidden = true;
    $("retryRow").hidden = false;
  } else if (current) {
    $("url").value = current;
  }
})();

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").textContent = "";
  $("go").disabled = true;
  const result = await window.huddleSetup.save($("url").value);
  if (result && result.error) {
    $("error").textContent = result.error;
    $("go").disabled = false;
  }
});
$("retry").addEventListener("click", () => window.huddleSetup.retry());
$("change").addEventListener("click", () => window.huddleSetup.changeServer());
