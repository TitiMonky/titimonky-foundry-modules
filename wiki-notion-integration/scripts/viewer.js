// Visionneuse : une fenêtre qui affiche la vraie page Notion (cadre /ebd/), avec son emplacement dans le wiki.
// Une seule fenêtre, réutilisée : ouvrir une autre page change seulement le cadre.
import { ID, getIndex, playersCanSee, canView, toggleFeatured, toggleFavorite } from "./data.js";

const { ApplicationV2 } = foundry.applications.api;
const APP_ID = "np-viewer";
export const SOCKET = `module.${ID}`;

class NotionViewer extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    classes: ["wiki-notion-integration", "np-viewer"],
    window: { title: "Wiki", icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 860, height: 720 }
  };

  page = null;
  #el = null;

  get title() { return this.page?.name ?? "Wiki"; }

  async _renderHTML() {
    return `<div class="np-view">
      <div class="np-bar">
        <span class="np-bar-icon"></span>
        <div class="np-bar-text"><div class="np-bar-title"></div><div class="np-bar-path"></div></div>
        ${game.user.isGM ? `<button type="button" class="np-ibtn np-star" data-act="featured"><i class="fa-regular fa-star"></i></button>` : ""}
        <button type="button" class="np-ibtn np-heart" data-act="favorite"><i class="fa-regular fa-heart"></i></button>
        <a class="np-btn ghost" data-act="open" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i>Ouvrir dans Notion</a>
        ${game.user.isGM ? `<button type="button" class="np-btn" data-act="show"><i class="fa-solid fa-display"></i>Montrer aux joueurs</button>` : ""}
      </div>
      <div class="np-frame"><span class="np-loading"><i class="fa-solid fa-spinner fa-spin"></i> Chargement de la page Notion…</span><iframe allowfullscreen></iframe></div>
    </div>`;
  }

  // Foundry appelle _replaceHTML avant d'enregistrer la fenêtre : on garde notre référence (piège du Jukebox).
  _replaceHTML(result, content) {
    if (!content.querySelector(".np-view")) {
      content.innerHTML = result;
      content.querySelector("[data-act=show]")?.addEventListener("click", () => showToPlayers(this.page));
      content.querySelector("[data-act=featured]")?.addEventListener("click", () => toggleFeatured(this.page));
      content.querySelector("[data-act=favorite]").addEventListener("click", () => toggleFavorite(this.page));
    }
    this.#el = content.querySelector(".np-view");
    this.#fill();
  }

  #fill() {
    const el = this.#el, page = this.page;
    if (!el || !page) return;
    const s = page.system;
    const item = getIndex().items.find(i => i.page === page);
    el.querySelector(".np-bar-icon").textContent = s.icon ?? "";
    el.querySelector(".np-bar-title").textContent = page.name;
    el.querySelector(".np-bar-path").textContent = item?.path.join(" › ") ?? "";
    const mark = (act, on, labelOn, labelOff, icon) => {
      const b = el.querySelector(`[data-act=${act}]`);
      if (!b) return;
      b.classList.toggle("is-on", !!on);
      b.dataset.tooltip = on ? labelOn : labelOff;
      b.innerHTML = `<i class="fa-${on ? "solid" : "regular"} ${icon}"></i>`;
    };
    mark("featured", item?.featured, "À la une : cliquer pour la retirer", "Mettre à la une (en tête du sommaire, pour toute la table)", "fa-star");
    mark("favorite", item?.favorite, "Dans mes favoris : cliquer pour la retirer", "Ajouter à mes favoris", "fa-heart");
    const open = el.querySelector("[data-act=open]");
    open.href = s.publicUrl || "#";
    open.hidden = !s.publicUrl;
    const frame = el.querySelector("iframe");
    if (frame.dataset.src !== s.embedUrl) {
      frame.dataset.src = s.embedUrl;
      frame.src = s.embedUrl || "about:blank";
    }
    const header = this.window?.title;
    if (header) header.textContent = page.name;
  }

  setPage(page) {
    this.page = page;
    this.#fill();
  }
}

export function openViewer(page) {
  if (!page || !canView(page)) return;
  const app = foundry.applications.instances.get(APP_ID);
  if (app) {
    app.setPage(page);
    app.bringToFront();
    if (app.minimized) app.maximize();
    return;
  }
  const viewer = new NotionViewer();
  viewer.page = page;
  viewer.render({ force: true });
}

export function refreshViewer() {
  const app = foundry.applications.instances.get(APP_ID);
  if (!app?.page) return;
  // Passer par game.journal : un journal supprimé garde encore ses pages en mémoire.
  const alive = game.journal.get(app.page.parent?.id)?.pages.get(app.page.id);
  if (!alive || !canView(alive)) return app.close();
  app.page = alive;
  app.setPage(app.page);
}

/** Montrer une page aux joueurs connectés : elle s'ouvre dans leur visionneuse (s'ils y ont droit). */
export function showToPlayers(page) {
  if (!game.user.isGM || !page) return;
  if (!playersCanSee(page)) {
    ui.notifications.warn(`« ${page.name} » est cachée aux joueurs : rendez-la visible (œil de la bibliothèque) avant de la montrer.`);
    return;
  }
  game.socket.emit(SOCKET, { action: "show", uuid: page.uuid });
  ui.notifications.info(`« ${page.name} » montrée aux joueurs connectés.`);
}

export async function onSocket(message) {
  if (message?.action !== "show" || game.user.isGM) return;
  const page = await foundry.utils.fromUuid(message.uuid);
  if (page) openViewer(page);
}
