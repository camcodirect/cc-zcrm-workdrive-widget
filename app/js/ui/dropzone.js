/**
 * Drag-and-drop plus the file picker. Both hand back a FileList, so they share
 * one code path.
 *
 * dragenter/dragleave fire for every child element the pointer crosses, which
 * makes the overlay flicker. A depth counter is the standard fix.
 */

export function initDropzone(zoneEl, onFiles) {
  let depth = 0;

  const show = () => zoneEl.classList.add("dragging");
  const hide = () => {
    depth = 0;
    zoneEl.classList.remove("dragging");
  };

  // Without preventDefault on dragover the browser just opens the file.
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  zoneEl.addEventListener("dragenter", (e) => {
    e.preventDefault();
    // Ignore text/element drags; only react to actual files.
    if (!hasFiles(e)) return;
    depth++;
    show();
  });

  zoneEl.addEventListener("dragleave", (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });

  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    hide();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) onFiles(Array.from(files));
  });

  // A file dropped outside the zone would otherwise navigate the iframe away.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

function hasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/** Opens the OS file picker and resolves through the same handler. */
export function initFilePicker(inputEl, onFiles) {
  inputEl.addEventListener("change", () => {
    const files = Array.from(inputEl.files || []);
    if (files.length) onFiles(files);
    // Reset so picking the same file twice still fires change.
    inputEl.value = "";
  });
}
