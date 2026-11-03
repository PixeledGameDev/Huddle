/**
 * The right-click menu: spelling suggestions, "Add to dictionary", links, pictures, and the usual cut/copy/paste.
 * It only builds the list; main.js supplies what each entry does, so this can be tested without Electron.
 *
 * `params` is what Electron reports about the spot that was clicked, `actions` are the things the menu can do.
 */
const isWebUrl = (u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

function buildContextMenu(params, actions, { isSafeExternal = isWebUrl } = {}) {
  const items = [];
  const word = params.misspelledWord;
  if (word) {
    for (const s of (params.dictionarySuggestions ?? []).slice(0, 5)) items.push({ label: s, click: () => actions.replaceMisspelling(s) });
    if (!params.dictionarySuggestions?.length) items.push({ label: "No suggestions", enabled: false });
    items.push({ label: `Add "${word.length > 24 ? `${word.slice(0, 24)}…` : word}" to dictionary`, click: () => actions.addToDictionary(word) });
    items.push({ type: "separator" });
  }
  if (params.linkURL && isSafeExternal(params.linkURL)) {
    items.push({ label: "Open link in browser", click: () => actions.openExternal(params.linkURL) });
    items.push({ label: "Copy link address", click: () => actions.copyText(params.linkURL) });
    items.push({ type: "separator" });
  }
  if (params.mediaType === "image" && params.srcURL && isWebUrl(params.srcURL)) {
    items.push({ label: "Copy image", click: () => actions.copyImage(params.x, params.y) });
    items.push({ label: "Save image as…", click: () => actions.saveImage(params.srcURL) });
    items.push({ type: "separator" });
  }
  if (params.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
  else if (params.selectionText) items.push({ role: "copy" });
  while (items.length && items[items.length - 1].type === "separator") items.pop();
  return items;
}

module.exports = { buildContextMenu, isWebUrl };
