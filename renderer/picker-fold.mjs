/**
 * Picker folding — the host's own model picker, folded by provider.
 *
 * pi-desktop has no slot inside the model picker and no action that could fold
 * a group, so this decorates the host's DOM instead: the renderer entry is
 * evaluated in the host's own window, which is the only reason the picker is
 * reachable at all. That makes this deliberately out-of-contract — the
 * selectors below are the host's own class names, and the host's arrow-key
 * navigation walks every model it knows about regardless of what is folded, so
 * the rows inside a folded group stay reachable from the keyboard.
 *
 * The fold state machine is the one the DSH plugin this was ported from used:
 * provider groups start folded, the current model's provider opens with the
 * menu, a search expands everything, and clearing the search folds back to the
 * current provider.
 *
 * A plain ES module with no build step: no host imports, no React.
 */

export const LIST_SELECTOR = ".composer-model-list";
export const GROUP_SELECTOR = ".composer-model-group";
export const LABEL_SELECTOR = ".composer-model-group-label";
export const ROW_SELECTOR = ".composer-model-option";
export const MODEL_LABEL_SELECTOR = ".composer-model-label";
export const SEARCH_SELECTOR = ".composer-model-search input";

const CHEVRON_ATTRIBUTE = "data-pi-model-accordion-fold";
const STYLE_ATTRIBUTE = "data-pi-model-accordion-fold-css";
const LABEL_CLASS = "mc-fold-label";
const CHEVRON_CLASS = "mc-fold-chevron";

/** The host's "recently used" heading, in the locales it ships. */
const RECENT_LABELS = new Set(["Recently used", "最近使用", "Usados recentemente"]);

const CSS = `
  .${LABEL_CLASS} {
    cursor: pointer;
    user-select: none;
  }
  .${LABEL_CLASS}:hover {
    opacity: 0.8;
  }
  .${CHEVRON_CLASS} {
    margin-inline-start: 6px;
    font-size: 9px;
    line-height: 1;
    opacity: 0.65;
  }
`;

/** The label's own text, without the chevron this module appends to it. */
export function labelText(element) {
  const text = element?.textContent ?? "";
  const suffix = element?.querySelector?.(`[${CHEVRON_ATTRIBUTE}]`)?.textContent ?? "";
  return (suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text).trim();
}

/**
 * Which groups should be open, given the search and the user's own choices.
 * Pure: the DOM pass and the tests read the same answer from here.
 */
export function planFold({ groups, query, overrides, collapsedByDefault = true }) {
  const searching = String(query ?? "").trim() !== "";
  const activeId = groups.find((group) => group.active)?.id;
  const open = new Map();
  for (const group of groups) {
    if (group.recent || searching) {
      open.set(group.id, true);
      continue;
    }
    const override = overrides?.get(group.id);
    open.set(group.id, override ?? (collapsedByDefault ? group.id === activeId : true));
  }
  return open;
}

/**
 * The fold state after a click on a provider heading: the accordion the ported
 * plugin used — the clicked provider opens and the others close — or, with
 * Ctrl/Cmd held, a toggle that leaves the others alone. Pure, like planFold.
 */
export function planClick({ groups, name, isOpen, multi = false, overrides }) {
  const next = new Map(overrides);
  if (multi) {
    next.set(name, !isOpen);
    return next;
  }
  const open = !isOpen;
  for (const group of groups) {
    if (group.recent || !group.id) continue;
    next.set(group.id, group.id === name ? open : false);
  }
  return next;
}

/**
 * Mark the host's "recently used" section. It and the provider groups are both
 * role="group", so this reads the heading instead: a known "recently used"
 * string, or — for a locale not listed — the first group when every model it
 * shows also appears under a provider. That section is never folded.
 */
export function markRecentGroups(groups) {
  const first = groups[0];
  if (!first) return groups;
  const elsewhere = new Set(groups.slice(1).flatMap((group) => group.modelNames ?? []));
  const known = RECENT_LABELS.has(first.label);
  const duplicated =
    (first.modelNames?.length ?? 0) > 0 && first.modelNames.every((name) => elsewhere.has(name));
  if (known || (groups.length > 1 && duplicated)) first.recent = true;
  return groups;
}

/**
 * Decorate the host's model picker with collapsible provider groups.
 * @param options.document - override for tests.
 * @param options.MutationObserver - override for tests.
 * @param options.collapsedByDefault - start folded (the ported behaviour).
 * @returns a disposer that puts the picker back the way it was.
 */
export function installPickerFold(options = {}) {
  const doc = options.document ?? globalThis.document;
  const Observer = options.MutationObserver ?? globalThis.MutationObserver;
  const collapsedByDefault = options.collapsedByDefault !== false;
  if (!doc || typeof Observer !== "function") return () => {};

  /** The user's own fold choices for this session, keyed by provider name. */
  const overrides = new Map();
  let previousQuery = "";
  let scheduled = false;
  let disposed = false;

  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "1");
  style.textContent = CSS;
  doc.head?.appendChild(style);

  function searchInput(list) {
    return (
      list?.parentElement?.querySelector?.(SEARCH_SELECTOR) ??
      doc.querySelector?.(SEARCH_SELECTOR) ??
      null
    );
  }

  function describe(list) {
    const groups = [...list.querySelectorAll(GROUP_SELECTOR)].map((element) => {
      const labelElement = element.querySelector(LABEL_SELECTOR);
      const rows = [...element.querySelectorAll(ROW_SELECTOR)];
      return {
        element,
        labelElement,
        id: labelText(labelElement),
        active: rows.some((row) => row.getAttribute("aria-checked") === "true"),
        modelNames: rows.map(
          (row) => row.querySelector(MODEL_LABEL_SELECTOR)?.textContent?.trim() ?? "",
        ),
        rows,
        recent: false,
      };
    });
    return markRecentGroups(groups);
  }

  function apply() {
    scheduled = false;
    if (disposed) return;
    const list = doc.querySelector(LIST_SELECTOR);
    if (!list) return;
    const query = searchInput(list)?.value ?? "";
    // Clearing the search folds back to the current model's provider.
    if (query.trim() === "" && previousQuery !== "") overrides.clear();
    previousQuery = query;
    const groups = describe(list);
    const open = planFold({ groups, query, overrides, collapsedByDefault });
    for (const group of groups) {
      const isOpen = open.get(group.id) !== false;
      for (const row of group.rows) {
        const display = isOpen ? "" : "none";
        if (row.style.display !== display) row.style.display = display;
      }
      if (group.recent || !group.labelElement || !group.id) continue;
      group.labelElement.classList.add(LABEL_CLASS);
      group.labelElement.setAttribute("aria-expanded", isOpen ? "true" : "false");
      let chevron = group.labelElement.querySelector(`[${CHEVRON_ATTRIBUTE}]`);
      if (!chevron) {
        chevron = doc.createElement("span");
        chevron.setAttribute(CHEVRON_ATTRIBUTE, "1");
        chevron.setAttribute("aria-hidden", "true");
        chevron.className = CHEVRON_CLASS;
        group.labelElement.appendChild(chevron);
      }
      const glyph = isOpen ? "\u25be" : "\u25b8";
      if (chevron.textContent !== glyph) chevron.textContent = glyph;
    }
  }

  /** Coalesce the host's re-renders: only the last one of a batch is applied. */
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    if (typeof queueMicrotask === "function") queueMicrotask(apply);
    else setTimeout(apply, 0);
  }

  function onClick(event) {
    const labelElement = event.target?.closest?.(LABEL_SELECTOR);
    // Only the labels this module decorated carry the attribute; the host's
    // "recently used" heading deliberately does not.
    const isOpen = labelElement?.getAttribute?.("aria-expanded");
    if (isOpen === null || isOpen === undefined) return;
    const list = doc.querySelector(LIST_SELECTOR);
    if (!list) return;
    const next = planClick({
      groups: describe(list),
      name: labelText(labelElement),
      isOpen: isOpen === "true",
      multi: Boolean(event.ctrlKey || event.metaKey),
      overrides,
    });
    overrides.clear();
    for (const [id, open] of next) overrides.set(id, open);
    apply();
  }

  const observer = new Observer(schedule);
  observer.observe?.(doc.body ?? doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("input", schedule, true);
  apply();

  return function dispose() {
    disposed = true;
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("input", schedule, true);
    observer.disconnect?.();
    style.remove?.();
    for (const group of doc.querySelectorAll(GROUP_SELECTOR)) {
      for (const row of group.querySelectorAll(ROW_SELECTOR)) row.style.display = "";
      const labelElement = group.querySelector(LABEL_SELECTOR);
      if (!labelElement) continue;
      labelElement.classList.remove(LABEL_CLASS);
      labelElement.removeAttribute("aria-expanded");
      labelElement.querySelector(`[${CHEVRON_ATTRIBUTE}]`)?.remove?.();
    }
  };
}
