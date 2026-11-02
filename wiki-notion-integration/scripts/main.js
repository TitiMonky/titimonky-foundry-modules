// Wiki Notion Integration : le wiki Notion publié dans Foundry (bibliothèque, visionneuse, épingles sur les scènes).
// Pas de serveur : le collecteur (favori) lit le site publié, le MJ importe le fichier ; les pages s'affichent en cadre.
import { ID, TYPE, NotionPageData, esc, getIndex, invalidate, canView } from "./data.js";
import { NotionPageSheet } from "./sheet.js";
import { toggleLibrary, refreshLibrary } from "./library.js";
import { openViewer, refreshViewer, showToPlayers, onSocket, SOCKET } from "./viewer.js";
import { openImport, openCollector, openAddPage } from "./import.js";

const setting = key => game.settings.get(ID, key);

/* ------------------------------------------------------------- pastille */

const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));
function place(el, left, top) {
  const { width, height } = el.getBoundingClientRect();
  Object.assign(el.style, {
    left: `${clamp(left, 0, window.innerWidth - width)}px`,
    top: `${clamp(top, 0, window.innerHeight - height)}px`
  });
}

// La pastille « Wiki » : déplaçable, position gardée par personne, clic = bibliothèque.
// Au-delà de 4 px c'est un déplacement, sinon un clic (même règle que le widget du Jukebox).
const Pill = {
  el: null,

  build() {
    const el = document.createElement("button");
    el.type = "button";
    el.id = "np-pill";
    el.className = "wiki-notion-integration np-ui np-pill";
    el.innerHTML = `<i class="fa-solid fa-book-open"></i><span>Wiki</span>`;
    el.setAttribute("aria-label", "Wiki : chercher une page (Alt+N)");
    document.body.append(el);
    this.el = el;

    el.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      const x0 = event.clientX, y0 = event.clientY;
      let moved = false;
      // Capture dès l'appui : capturée seulement au départ du déplacement, la pastille perdait les mouvements quand la
      // souris la quittait vite, puis rattrapait (effet d'inertie).
      try { el.setPointerCapture(event.pointerId); } catch {}
      const move = e => {
        if (!moved) {
          if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
          moved = true;
          el.classList.add("is-dragging");
        }
        // Positionnement direct (sans mesurer la pastille à chaque mouvement) ; bornes à l'écran.
        el.style.left = `${clamp(e.clientX - dx, 0, window.innerWidth - rect.width)}px`;
        el.style.top = `${clamp(e.clientY - dy, 0, window.innerHeight - rect.height)}px`;
      };
      const end = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        if (!moved) return;
        el.classList.remove("is-dragging");
        el.dataset.dragged = "1";
        setTimeout(() => delete el.dataset.dragged, 0);
        game.settings.set(ID, "pillPos", { left: parseFloat(el.style.left), top: parseFloat(el.style.top) });
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
    el.addEventListener("click", () => { if (!el.dataset.dragged) toggleLibrary(); });
    window.addEventListener("resize", () => this.restore());
    this.update();
  },

  restore() {
    if (!this.el || this.el.hidden) return;
    const pos = setting("pillPos");
    // Par défaut : en haut, à droite de la barre des scènes (rien de Foundry n'y est posé).
    place(this.el, pos?.left ?? 330, pos?.top ?? 12);
  },

  // Cachée chez un joueur qui n'a aucune page à lire ; toujours là pour le MJ (il doit pouvoir importer).
  update() {
    if (!this.el) return;
    this.el.hidden = !setting("showPill") || (!game.user.isGM && !getIndex().items.length);
    this.restore();
  }
};

/* ----------------------------------------------------------- infobulle */

// Survol d'une épingle de page Notion : chemin, titre et début du texte (Foundry n'affiche que le nom).
const Tip = {
  el: null,
  noteId: null,
  show(note) {
    const page = note.document.page;
    if (page?.type !== TYPE || !canView(page)) return this.hide();
    this.noteId = note.document.id;
    const item = getIndex().items.find(i => i.page === page);
    this.el ??= Object.assign(document.createElement("div"), { className: "wiki-notion-integration np-ui np-tip" });
    const text = item?.excerptSource.slice(0, 150) ?? "";
    this.el.innerHTML = `${item?.path.length ? `<span class="np-tip-c">${esc(item.path.slice(-2).join(" › "))}</span>` : ""}
      <b>${page.system.icon ? esc(page.system.icon) + " " : ""}${esc(page.name)}</b>
      ${text ? `<span class="np-tip-x">${esc(text)}${item.excerptSource.length > 150 ? "…" : ""}</span>` : ""}
      <span class="np-tip-k">Double-clic : ouvrir la page</span>`;
    document.body.append(this.el);
    const { x, y } = canvas.clientCoordinatesFromCanvas(note.center);
    const r = note.bounds.width * canvas.stage.scale.x / 2;
    place(this.el, x + r + 10, y - 20);
  },
  hide() { this.el?.remove(); this.noteId = null; }
};

/* ---------------------------------------------------------------- hooks */

Hooks.once("init", () => {
  CONFIG.JournalEntryPage.dataModels[TYPE] = NotionPageData;
  foundry.applications.apps.DocumentSheetConfig.registerSheet(foundry.documents.JournalEntryPage, ID, NotionPageSheet, {
    types: [TYPE],
    makeDefault: true,
    label: "Page Notion"
  });

  const reg = (key, data) => game.settings.register(ID, key, data);
  reg("showPill", {
    scope: "client", config: true, type: Boolean, default: true,
    name: "Afficher la pastille « Wiki »",
    hint: "Le bouton déplaçable qui ouvre la bibliothèque. Sans lui : raccourci Alt+N.",
    onChange: () => Pill.update()
  });
  reg("pillPos", { scope: "client", type: Object, default: {} });
  reg("featured", { scope: "world", type: Array, default: [], onChange: () => changed() });

  game.keybindings.register(ID, "library", {
    name: "Ouvrir / fermer le wiki",
    // N est à la même place en AZERTY et en QWERTY (docs/pieges-foundry.md, raccourcis).
    editable: [{ key: "KeyN", modifiers: ["Alt"] }],
    onDown: () => { toggleLibrary(); return true; }
  });
});

Hooks.once("ready", () => {
  Pill.build();
  game.socket.on(SOCKET, onSocket);
  game.modules.get(ID).api = {
    open: toggleLibrary,
    show: uuid => foundry.utils.fromUuid(uuid).then(showToPlayers),
    view: uuid => foundry.utils.fromUuid(uuid).then(openViewer),
    import: openImport,
    collector: openCollector,
    addPage: openAddPage
  };
});

// Tout changement de pages ou de droits : l'index est refait à la demande, les fenêtres ouvertes se mettent à jour.
let refreshQueued = false;
function changed() {
  invalidate();
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refreshLibrary();
    refreshViewer();
    Pill.update();
    // Une page cachée ou rendue visible (œil) : Foundry ne revoit la visibilité des épingles qu'au changement de la note.
    for (const note of canvas.notes?.placeables ?? []) note.renderFlags.set({ refreshVisibility: true });
  }, 50);
}
for (const hook of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage",
  "createJournalEntry", "updateJournalEntry", "deleteJournalEntry"]) Hooks.on(hook, changed);
// Mes favoris (flag de l'utilisateur) : seulement les miens.
Hooks.on("updateUser", (user, diff) => { if (user.isSelf && diff.flags?.[ID] !== undefined) changed(); });

// Double-clic sur une épingle d'une page Notion : la visionneuse plutôt que le journal entier.
Hooks.on("activateNote", (note, options) => {
  const page = note.document.page;
  if (page?.type !== TYPE) return;
  openViewer(page);
  return false;
});

// Une épingle supprimée ou déplacée sous la souris ne reçoit pas de « fin de survol » : l'infobulle restait affichée.
Hooks.on("hoverNote", (note, hovered) => {
  if (hovered) Tip.show(note);
  else if (!Tip.noteId || Tip.noteId === note.document.id) Tip.hide();
});
for (const hook of ["deleteNote", "updateNote"]) Hooks.on(hook, doc => { if (doc.id === Tip.noteId) Tip.hide(); });
Hooks.on("canvasTearDown", () => Tip.hide());
