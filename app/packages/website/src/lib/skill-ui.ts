// Behaviour shared by the skill modals and the homepage's agent modal:
// opening and closing a modal, tab sets, and copy buttons. Everything is
// found by data attributes, so any number of modals and tab sets can share it.
//
// - `[data-open-modal="<id>"]` opens the `.modal-overlay` with that id;
//   `[data-close-modal]` inside one closes it, as do Escape and a click on
//   the backdrop.
// - Buttons `[data-tab="<key>"]` and panels `[data-panel="<key>"]` sharing a
//   `data-tabset` form one tab set; the first button starts active.
// - `[data-skill-copy]` copies the code of the `.agent-skill-file` it is in.

function openModal(modal: HTMLElement) {
  modal.setAttribute("data-open", "");
  document.body.style.overflow = "hidden";
  setTimeout(() => modal.querySelector<HTMLElement>("[data-close-modal]")?.focus(), 100);
}

function closeModal(modal: HTMLElement) {
  modal.removeAttribute("data-open");
  document.body.style.overflow = "";
}

function activate(tabset: string, key: string) {
  document.querySelectorAll<HTMLElement>(`[data-tabset="${tabset}"]`).forEach((el) => {
    const on = (el.dataset.tab ?? el.dataset.panel) === key;
    on ? el.setAttribute("data-active", "") : el.removeAttribute("data-active");
    if (el.dataset.tab !== undefined) el.setAttribute("aria-selected", String(on));
  });
}

document.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;

  const opener = target.closest<HTMLElement>("[data-open-modal]");
  if (opener) {
    const modal = document.getElementById(opener.dataset.openModal!);
    if (modal) {
      e.preventDefault();
      openModal(modal);
    }
    return;
  }

  const closer = target.closest<HTMLElement>("[data-close-modal]");
  if (closer) {
    const modal = closer.closest<HTMLElement>(".modal-overlay");
    if (modal) closeModal(modal);
    return;
  }

  if (target.classList.contains("modal-overlay") && target.hasAttribute("data-open")) {
    closeModal(target);
    return;
  }

  const tab = target.closest<HTMLElement>("[data-tab][data-tabset]");
  if (tab) {
    activate(tab.dataset.tabset!, tab.dataset.tab!);
    return;
  }

  const copy = target.closest<HTMLElement>("[data-skill-copy]");
  if (copy) {
    const code = copy
      .closest(".agent-skill-file")
      ?.querySelector(".agent-skill-code code")?.textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      const label = copy.textContent;
      copy.textContent = "Copied!";
      setTimeout(() => (copy.textContent = label), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll<HTMLElement>(".modal-overlay[data-open]").forEach(closeModal);
});

// Start each tab set on its first tab.
const seen = new Set<string>();
document.querySelectorAll<HTMLElement>("[data-tab][data-tabset]").forEach((tab) => {
  const set = tab.dataset.tabset!;
  if (seen.has(set)) return;
  seen.add(set);
  activate(set, tab.dataset.tab!);
});
