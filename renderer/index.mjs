/**
 * Model Catalog — renderer entry (`local.pi-model-accordion`).
 *
 * Two surfaces:
 *
 * 1. A composer control: a button that sits in the composer toolbar and opens
 *    this plugin's model list in the work panel.
 * 2. Picker folding: the host's own model picker, with its provider groups
 *    collapsible. No renderer slot reaches inside that picker, so the folding
 *    decorates the host's DOM — see `picker-fold.mjs` for exactly what that
 *    covers and what it cannot.
 *
 * A plain ES module with no build step; `react` resolves to the host's through
 * the window's import map.
 */
import { createElement as h, useState } from "react";
import { installPickerFold } from "./picker-fold.mjs";

const PICKER_FOLD_METHOD = "modelCatalog.pickerFold";

/** The load's `pi`, kept because the component renders outside `onLoad`. */
let host = null;

/** The picker decoration's disposer, for `onUnload`. */
let disposeFold = null;

/** Set once the host unloads, so a late settings reply cannot reinstall. */
let unloaded = false;

const CSS = `
  .mc-open {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    opacity: 0.75;
  }
  .mc-open:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }
  .mc-open[data-pi-model-accordion-result="pending"] {
    opacity: 0.5;
  }
  .mc-open[data-pi-model-accordion-result="error"] {
    color: #d9534f;
  }
`;

function OpenControl() {
  const [result, setResult] = useState("idle");
  const open = () => {
    setResult("pending");
    host.dispatch("plugin.call", { method: "modelCatalog.openView", args: {} }).then(
      () => setResult("ok"),
      () => setResult("error"),
    );
  };
  return h(
    "button",
    {
      type: "button",
      className: "mc-open",
      "data-pi-model-accordion-control": "open",
      "data-pi-model-accordion-result": result,
      title: "Model Catalog — 模型列表",
      onClick: open,
    },
    h("span", { "aria-hidden": "true" }, "▤"),
    h("span", { className: "sr-only" }, "PI Model Accordion"),
  );
}

export function onLoad(pi) {
  host = pi;
  unloaded = false;
  pi.ui.injectStyle(CSS);
  pi.slots.register({ slot: "composerControl", component: OpenControl, positions: ["right"] });
  // Picker folding is opt-out: a host whose picker no longer matches these
  // selectors can switch it off in the plugin's settings without uninstalling.
  Promise.resolve(pi.dispatch("plugin.call", { method: PICKER_FOLD_METHOD, args: {} }))
    .then((fold) => {
      if (unloaded || !fold?.enabled) return;
      disposeFold = installPickerFold({
        collapsedByDefault: fold.collapsedByDefault !== false,
      });
    })
    .catch(() => {});
}

export function onUnload() {
  unloaded = true;
  disposeFold?.();
  disposeFold = null;
  host = null;
}
