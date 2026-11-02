// Bibliothèque : sommaire du wiki (arborescence Notion, dépliable) à gauche, recherche et résultats à droite.
// Une page affichée par plusieurs vues apparaît dans chacune ; le sommaire ne montre que les conteneurs.
import { esc, getIndex, search, highlight, excerpt, subtree, childNodes, setPlayersCanSee, toggleFeatured, toggleFavorite } from "./data.js";
import { openViewer, showToPlayers } from "./viewer.js";
import { openImport, openCollector, openAddPage } from "./import.js";

const { ApplicationV2 } = foundry.applications.api;
const APP_ID = "np-library";
const MAX_RESULTS = 80;

// L'état survit à la fermeture de la fenêtre (on la rouvre là où on l'avait laissée).
const state = { query: "", node: null, open: new Set() };

const SHELL = () => `<div class="np-lib">
  <div class="np-top">
    <label class="np-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Chercher une page" autocomplete="off"></label>
    ${game.user.isGM ? `<button type="button" class="np-ibtn" data-act="menu" aria-label="Gérer le wiki"><i class="fa-solid fa-gear"></i></button>` : ""}
  </div>
  <div class="np-body">
    <nav class="np-toc"></nav>
    <div class="np-main"><div class="np-count"></div><div class="np-list"></div></div>
  </div>
</div>`;

class LibraryApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    classes: ["wiki-notion-integration", "np-library"],
    window: { title: "Wiki", icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 860, height: 640 }
  };

  async _renderHTML() { return SHELL(); }

  _replaceHTML(result, content) {
    if (!content.querySelector(".np-lib")) {
      content.innerHTML = result;
      Library.wire(content.querySelector(".np-lib"));
    }
    Library.el = content.querySelector(".np-lib");
    Library.refresh();
  }

  _onClose(options) {
    super._onClose(options);
    Library.el = null;
    closeMenu();
  }
}

export const Library = {
  el: null,

  wire(el) {
    const input = el.querySelector("input");
    input.value = state.query;
    input.addEventListener("input", () => { state.query = input.value; this.refreshResults(); });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      const first = el.querySelector(".np-res");
      if (first) openViewer(getIndex().items.find(i => i.uuid === first.dataset.uuid)?.page);
    });
    el.querySelector("[data-act=menu]")?.addEventListener("click", event => openMenu(event.currentTarget));

    el.querySelector(".np-toc").addEventListener("click", event => {
      const pin = event.target.closest("[data-open]");
      if (pin) return openViewer(getIndex().items.find(i => i.uuid === pin.dataset.open)?.page);
      const a = event.target.closest("[data-k]");
      if (!a) return;
      const key = a.dataset.k;
      if (event.target.closest("[data-tw]")) state.open.has(key) ? state.open.delete(key) : state.open.add(key);
      else { state.node = key || null; if (key) state.open.add(key); }
      this.refresh();
    });

    const list = el.querySelector(".np-list");
    list.addEventListener("click", async event => {
      const row = event.target.closest(".np-res");
      if (!row) return;
      const item = getIndex().items.find(i => i.uuid === row.dataset.uuid);
      if (!item) return;
      if (event.target.closest("[data-act=eye]")) return setPlayersCanSee(item.page, item.hidden);
      if (event.target.closest("[data-act=show]")) return showToPlayers(item.page);
      if (event.target.closest("[data-act=featured]")) return toggleFeatured(item.page);
      if (event.target.closest("[data-act=favorite]")) return toggleFavorite(item.page);
      openViewer(item.page);
    });
    el.addEventListener("contextmenu", onContextMenu);
    // Glisser une ligne sur la scène : Foundry crée une note (épingle) liée à la page.
    list.addEventListener("dragstart", event => {
      const row = event.target.closest(".np-res");
      if (!row) return;
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "JournalEntryPage", uuid: row.dataset.uuid }));
    });
  },

  refresh() {
    if (!this.el) return;
    const index = getIndex();
    if (state.node && !nodeExists(index, state.node)) state.node = null;
    this.el.querySelector(".np-toc").innerHTML = tocHTML(index);
    this.refreshResults();
  },

  refreshResults() {
    if (!this.el) return;
    const index = getIndex();
    const q = state.query;
    let res;
    const special = SPECIAL[state.node];
    if (special) {
      // À la une / favoris : dans leur ordre (le plus récent en tête) tant qu'on ne cherche rien.
      const list = special.list(index);
      res = q.trim() ? search(index, q, i => list.includes(i)) : list;
    } else {
      let inNode = null;
      if (state.node) {
        inNode = subtree(index, state.node);
        if (state.node.startsWith("p|")) inNode.add(state.node.slice(2));
      }
      res = search(index, q, inNode ? i => inNode.has(i.nid) : null);
    }
    const label = state.node ? this.el.querySelector(".np-toc .on .np-tl")?.textContent.trim() : "";
    this.el.querySelector(".np-count").textContent = `${res.length} page${res.length > 1 ? "s" : ""}${label ? " · " + label : ""}`;
    const list = this.el.querySelector(".np-list");
    if (!index.items.length) {
      list.innerHTML = `<div class="np-empty">${game.user.isGM
        ? "Aucune page Notion pour l'instant. Bouton <i class=\"fa-solid fa-gear\"></i> : <b>Installer le collecteur</b>, puis <b>Importer le wiki</b>, ou <b>Ajouter une page</b>."
        : "Aucune page du wiki n'est partagée pour l'instant."}</div>`;
      return;
    }
    list.innerHTML = res.slice(0, MAX_RESULTS).map(item => rowHTML(item, q)).join("")
      + (res.length > MAX_RESULTS ? `<div class="np-more">… et ${res.length - MAX_RESULTS} autres : précisez la recherche.</div>` : "")
      || `<div class="np-empty">Aucune page ne correspond${state.node ? " dans cette partie" : ""}.</div>`;
  }
};

// Sections en tête du sommaire : « f » = à la une (MJ, pour tous), « v » = favoris (à chacun).
const SPECIAL = {
  f: { list: index => index.featured, label: "À la une", icon: "fa-solid fa-star", cls: "is-featured",
    empty: () => game.user.isGM ? `<i class="fa-regular fa-star"></i> sur une page pour la mettre en avant pour toute la table` : "" },
  v: { list: index => index.favorites, label: "Mes favoris", icon: "fa-solid fa-heart", cls: "is-favorite",
    empty: () => `<i class="fa-regular fa-heart"></i> sur une page pour la garder ici` }
};
const PINS_SHOWN = 8;

function nodeExists(index, key) {
  if (key === "m" || SPECIAL[key]) return true;
  const [kind, pid] = key.split("|");
  return kind === "g" ? index.kids.has(pid) : index.byNid.has(pid) || index.kids.has(pid);
}

function rowHTML(item, q) {
  const gm = game.user.isGM;
  const where = item.path.slice(-2).join(" › ");
  return `<div class="np-res${item.hidden ? " is-hidden" : ""}" data-uuid="${esc(item.uuid)}" draggable="true">
    <span class="np-ic">${item.icon ? esc(item.icon) : `<i class="fa-regular fa-file-lines"></i>`}</span>
    <span class="np-head"><span class="np-t">${highlight(item.title, q)}</span>${where ? ` <span class="np-c">· ${esc(where)}</span>` : ""}</span>
    <span class="np-gm">
      ${gm ? `<button type="button" class="np-ibtn np-star${item.featured ? " is-on" : ""}" data-act="featured" data-tooltip="${item.featured ? "À la une : cliquer pour la retirer" : "Mettre à la une (en tête du sommaire, pour toute la table)"}"><i class="fa-${item.featured ? "solid" : "regular"} fa-star"></i></button>` : ""}
      <button type="button" class="np-ibtn np-heart${item.favorite ? " is-on" : ""}" data-act="favorite" data-tooltip="${item.favorite ? "Dans mes favoris : cliquer pour la retirer" : "Ajouter à mes favoris"}"><i class="fa-${item.favorite ? "solid" : "regular"} fa-heart"></i></button>
    ${gm ? `
      <button type="button" class="np-ibtn${item.hidden ? " is-off" : ""}" data-act="eye" data-tooltip="${item.hidden ? "Cachée aux joueurs : cliquer pour la montrer dans leur bibliothèque" : "Visible par les joueurs : cliquer pour la cacher"}"><i class="fa-solid ${item.hidden ? "fa-eye-slash" : "fa-eye"}"></i></button>
      <button type="button" class="np-ibtn" data-act="show" data-tooltip="Montrer aux joueurs connectés"><i class="fa-solid fa-display"></i></button>` : ""}
    </span>
    <span class="np-x">${highlight(excerpt(item, q), q)}</span>
  </div>`;
}

function tocHTML(index) {
  const count = key => {
    const ids = subtree(index, key);
    if (key.startsWith("p|")) ids.add(key.slice(2));
    return ids.size;
  };
  const node = (it, depth) => {
    const n = count(it.key);
    if (!n) return "";
    const inner = treeHTML(it.key, depth + 1);
    const open = state.open.has(it.key);
    const icon = it.emoji ? `<span class="np-emoji">${esc(it.emoji)}</span>` : it.view ? `<i class="fa-solid fa-table-list np-ti"></i>` : it.icon ?? `<i class="fa-regular fa-file-lines np-ti"></i>`;
    return `<div class="np-tn"><a class="${it.key === state.node ? "on" : ""}" data-k="${esc(it.key)}" style="padding-left:${4 + depth * 13}px">`
      + (inner ? `<i class="fa-solid fa-chevron-${open ? "down" : "right"} np-tw" data-tw></i>` : `<i class="np-tw"></i>`)
      + `<span class="np-tl">${icon}${esc(it.label)}</span><small>${n}</small></a>${inner && open ? inner : ""}</div>`;
  };
  const treeHTML = (key, depth) => childNodes(index, key).map(it => node(it, depth)).join("");

  let html = specialHTML(index) + `<div class="np-tn"><a class="${state.node ? "" : "on"}" data-k=""><i class="np-tw"></i><span class="np-tl"><i class="fa-solid fa-house np-ti"></i>${
    esc(index.wikis.length === 1 ? index.wikis[0].title : "Tout le wiki")}</span><small>${index.items.length}</small></a></div>`;
  if (index.wikis.length === 1) html += treeHTML(`p|${index.wikis[0].root}`, 0);
  else html += index.wikis.map(w => node({ key: `p|${w.root}`, label: w.title, icon: `<i class="fa-solid fa-book np-ti"></i>` }, 0)).join("");
  html += node({ key: "m", label: "Ajoutées à la main", icon: `<i class="fa-solid fa-thumbtack np-ti"></i>` }, 0);
  return html;
}

// À la une puis Mes favoris, au-dessus de l'arborescence : un titre (clic = ces pages dans les résultats, avec leur
// extrait) et les pages elles-mêmes (clic = la page s'ouvre). Section vide : une aide, ou rien chez un joueur.
function specialHTML(index) {
  const html = Object.entries(SPECIAL).map(([key, s]) => {
    const list = s.list(index);
    const hint = s.empty();
    if (!list.length && !hint) return "";
    const pins = list.slice(0, PINS_SHOWN).map(i => `<a class="np-pin${i.hidden ? " is-hidden" : ""}" data-open="${esc(i.uuid)}">`
      + `${i.icon ? `<span class="np-emoji">${esc(i.icon)}</span>` : `<i class="fa-regular fa-file-lines np-ti"></i>`}<span class="np-tl">${esc(i.title)}</span></a>`).join("");
    const more = list.length > PINS_SHOWN ? `<a class="np-pin np-pin-more" data-k="${key}">… et ${list.length - PINS_SHOWN} autres</a>` : "";
    return `<div class="np-sec ${s.cls}"><div class="np-tn"><a class="np-sec-h${state.node === key ? " on" : ""}" data-k="${key}"><i class="np-tw"></i>`
      + `<span class="np-tl"><i class="${s.icon} np-ti"></i>${s.label}</span>${list.length ? `<small>${list.length}</small>` : ""}</a></div>`
      + (list.length ? pins + more : `<div class="np-sec-hint">${hint}</div>`) + `</div>`;
  }).join("");
  return html ? `${html}<div class="np-sec-rule"></div>` : "";
}

/* ------------------------------------------------------------------- menu */

let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }

// Un menu flottant : { icon, label, run } ; { sep: true } = filet. Placé dans l'écran (x, y = coin voulu).
function showMenu(items, x, y, alignRight = false) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "wiki-notion-integration np-ui np-menu";
  menuEl.innerHTML = items.map((it, i) => it.sep ? `<hr>`
    : `<button type="button" data-i="${i}"><i class="${it.icon.includes(" ") ? it.icon : `fa-solid ${it.icon}`}"></i>${esc(it.label)}</button>`).join("");
  document.body.append(menuEl);
  const { offsetWidth: w, offsetHeight: h } = menuEl;
  menuEl.style.left = `${Math.max(8, Math.min((alignRight ? x - w : x), window.innerWidth - w - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  menuEl.addEventListener("click", event => {
    const b = event.target.closest("[data-i]");
    if (!b) return;
    closeMenu();
    items[b.dataset.i].run();
  });
}

function openMenu(button) {
  if (menuEl) return closeMenu();
  const r = button.getBoundingClientRect();
  showMenu([
    { icon: "fa-file-import", label: "Importer le wiki…", run: openImport },
    { icon: "fa-bookmark", label: "Installer le collecteur…", run: openCollector },
    { icon: "fa-plus", label: "Ajouter une page Notion…", run: openAddPage }
  ], r.right, r.bottom + 4, true);
}

// Clic droit sur une page (sommaire ou résultats) : les mêmes actions que les boutons, plus quelques autres.
function pageActions(item) {
  const gm = game.user.isGM;
  const url = item.page.system.publicUrl;
  return [
    { icon: "fa-book-open", label: "Ouvrir", run: () => openViewer(item.page) },
    url && { icon: "fa-arrow-up-right-from-square", label: "Ouvrir dans Notion", run: () => window.open(url, "_blank", "noopener") },
    { sep: true },
    { icon: item.favorite ? "fa-solid fa-heart" : "fa-regular fa-heart", label: item.favorite ? "Retirer de mes favoris" : "Ajouter à mes favoris", run: () => toggleFavorite(item.page) },
    gm && { icon: item.featured ? "fa-solid fa-star" : "fa-regular fa-star", label: item.featured ? "Retirer de la une" : "Mettre à la une", run: () => toggleFeatured(item.page) },
    gm && { sep: true },
    gm && { icon: "fa-display", label: "Montrer aux joueurs", run: () => showToPlayers(item.page) },
    gm && { icon: item.hidden ? "fa-eye" : "fa-eye-slash", label: item.hidden ? "Rendre visible aux joueurs" : "Cacher aux joueurs", run: () => setPlayersCanSee(item.page, item.hidden) }
  ].filter(Boolean);
}

/** La page visée par un clic droit : ligne de résultat, page à la une / en favori, ou page du sommaire. */
function itemAt(target) {
  const index = getIndex();
  const uuid = target.closest(".np-res")?.dataset.uuid ?? target.closest("[data-open]")?.dataset.open;
  if (uuid) return index.items.find(i => i.uuid === uuid);
  const key = target.closest("[data-k]")?.dataset.k;
  if (key?.startsWith("p|")) return index.byNid.get(key.slice(2));
  if (key === "" && index.wikis.length === 1) return index.byNid.get(index.wikis[0].root);
  return null;
}

export function onContextMenu(event) {
  const item = itemAt(event.target);
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  showMenu(pageActions(item), event.clientX, event.clientY);
}
document.addEventListener("pointerdown", event => {
  if (menuEl && !menuEl.contains(event.target) && !event.target.closest("[data-act=menu]")) closeMenu();
}, true);

/* -------------------------------------------------------------- ouverture */

export function toggleLibrary() {
  const app = foundry.applications.instances.get(APP_ID);
  if (app) return app.close();
  new LibraryApp().render({ force: true });
}

export function refreshLibrary() {
  Library.refresh();
}
