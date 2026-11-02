// Import du wiki (MJ) : le fichier du collecteur → pages de journal « Notion », avec un bilan avant d'appliquer.
// Aussi : installer le collecteur (favori) et ajouter une page à la main.
import { ID, TYPE, esc, shortId, parseNotionUrl, titleFromUrl } from "./data.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;
const FORMAT = "notion-pages-wiki";

/* -------------------------------------------------------------- analyse */

/** Lit le fichier du collecteur et le ramène à des identifiants courts (32 caractères, sans tirets). */
function readWiki(json) {
  const data = JSON.parse(json);
  if (data?.format !== FORMAT || !Array.isArray(data.pages)) throw new Error("ce fichier ne vient pas du collecteur Wiki Notion Integration");
  const root = shortId(data.root);
  // Les champs texte de Foundry retirent les espaces de bout : on fait pareil, sinon chaque réimport verrait des
  // « modifications ». Une propriété sans valeur (relation vers une page non publiée → « , ») est écartée.
  const clean = s => String(s ?? "").trim();
  const pages = data.pages.map(p => ({
    id: shortId(p.id), title: clean(p.title) || "Sans titre", icon: clean(p.icon), text: clean(p.text),
    props: (Array.isArray(p.props) ? p.props : []).map(clean).filter(s => s && !/:[\s,]*$/.test(s)).map(s => s.replace(/^:\s*/, "")),
    edited: Number.isFinite(p.edited) ? p.edited : null,
    locations: (p.locations?.length ? p.locations : p.parent ? [{ parent: p.parent, group: p.group }] : [])
      .map(l => ({ parent: shortId(l.parent), group: l.group ?? null }))
  }));
  return { site: String(data.site), root, rootTitle: data.rootTitle ?? "Wiki", collectedAt: data.collectedAt, pages };
}

/** Parties qu'on peut écarter : les sous-pages et les vues de la page d'accueil. */
function partsOf(wiki) {
  const parts = new Map();
  for (const p of wiki.pages) for (const l of p.locations) {
    if (l.parent !== wiki.root) continue;
    const key = l.group ? `g:${l.parent}|${l.group}` : `p:${p.id}`;
    if (!parts.has(key)) parts.set(key, { key, label: l.group ?? p.title, view: !!l.group, count: 0 });
  }
  return [...parts.values()];
}

/**
 * Pages gardées : celles qu'on atteint depuis l'accueil sans passer par une partie écartée. Une partie écartée est
 * une « coulisse » : la page n'apparaît pas, mais ses fiches restent si une vue les montre ailleurs (le Backend de
 * Meyiv : bases rangées là, montrées dans les pages des mondes).
 */
function plan(wiki, excluded) {
  const exPage = new Set([...excluded].filter(k => k.startsWith("p:")).map(k => k.slice(2)));
  const exView = new Set([...excluded].filter(k => k.startsWith("g:")).map(k => k.slice(2)));
  const byId = new Map(wiki.pages.map(p => [p.id, p]));
  const memo = new Map(), visiting = new Set();
  const okLoc = l => !exView.has(`${l.parent}|${l.group ?? ""}`);
  const kept = id => {
    if (id === wiki.root) return true;
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id) || exPage.has(id) || !byId.has(id)) return false;
    visiting.add(id);
    const r = byId.get(id).locations.some(l => okLoc(l) && kept(l.parent));
    visiting.delete(id);
    memo.set(id, r);
    return r;
  };
  const pages = wiki.pages.filter(p => kept(p.id)).map(p => ({
    ...p, locations: p.locations.filter(l => okLoc(l) && kept(l.parent))
  }));
  // Compte par partie (premier emplacement), pour l'affichage.
  const parts = partsOf(wiki);
  const keyOf = p => {
    let cur = p, guard = 0;
    while (cur && guard++ < 20) {
      const l = cur.locations[0];
      if (!l) return null;
      if (l.parent === wiki.root) return l.group ? `g:${l.parent}|${l.group}` : `p:${cur.id}`;
      cur = byId.get(l.parent);
    }
    return null;
  };
  for (const p of wiki.pages) {
    const part = parts.find(x => x.key === keyOf(p));
    if (part) part.count++;
  }
  return { pages, parts };
}

const findEntry = root => game.journal.find(e => e.getFlag(ID, "root") === root);

function pageData(wiki, p, sort) {
  return {
    name: p.title, type: TYPE, sort,
    title: { show: true, level: 1 },
    system: {
      site: wiki.site, notionId: p.id, icon: p.icon, text: p.text, props: p.props,
      locations: p.locations, wiki: wiki.root, edited: p.edited
    }
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diff(wiki, pages, entry) {
  const existing = new Map((entry?.pages ?? []).filter(pg => pg.type === TYPE && pg.system.wiki === wiki.root).map(pg => [pg.system.notionId, pg]));
  const added = [], changed = [], removed = [];
  for (const p of pages) {
    const pg = existing.get(p.id);
    if (!pg) { added.push(p); continue; }
    existing.delete(p.id);
    const s = pg.system;
    if (pg.name !== p.title || s.icon !== p.icon || s.text !== p.text || s.site !== wiki.site
      || !same(s.props, p.props) || !same(s.locations.map(l => ({ parent: l.parent, group: l.group ?? null })), p.locations)) changed.push({ p, pg });
  }
  for (const pg of existing.values()) removed.push(pg);
  return { added, changed, removed };
}

/* ---------------------------------------------------------------- fenêtre */

class ImportApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "np-import",
    classes: ["notion-pages", "np-import"],
    window: { title: "Importer le wiki", icon: "fa-solid fa-file-import", resizable: true },
    position: { width: 620, height: "auto" }
  };

  wiki = null;
  fileName = "";
  excluded = new Set();
  #el = null;
  #busy = false;

  async _renderHTML() { return `<div class="np-imp"></div>`; }

  _replaceHTML(result, content) {
    if (!content.querySelector(".np-imp")) {
      content.innerHTML = result;
      this.#wire(content.querySelector(".np-imp"));
    }
    this.#el = content.querySelector(".np-imp");
    this.#draw();
  }

  #wire(el) {
    el.addEventListener("change", async event => {
      if (event.target.matches("input[type=file]")) {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          this.wiki = readWiki(await file.text());
          this.fileName = file.name;
          const entry = findEntry(this.wiki.root);
          this.excluded = new Set(entry?.getFlag(ID, "excluded") ?? []);
        } catch (err) {
          this.wiki = null;
          ui.notifications.error(`Wiki Notion Integration : fichier illisible (${err.message}).`);
        }
        this.#draw();
      }
      if (event.target.matches("[data-part]")) {
        event.target.checked ? this.excluded.delete(event.target.dataset.part) : this.excluded.add(event.target.dataset.part);
        this.#draw();
      }
    });
    el.addEventListener("click", event => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (act === "collector") openCollector();
      if (act === "cancel") this.close();
      if (act === "apply") this.#apply();
    });
  }

  #draw() {
    const el = this.#el;
    if (!el) return;
    const fileCard = `<div class="np-card"><h3>Fichier</h3>
      <div class="np-file"><label class="np-btn ghost"><i class="fa-solid fa-folder-open"></i>Choisir…<input type="file" accept=".json,application/json" hidden></label>
      <span>${this.wiki ? `${esc(this.fileName)} · <span class="np-soft">collecté le ${esc(new Date(this.wiki.collectedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))} depuis « ${esc(this.wiki.rootTitle)} »</span>`
        : `<span class="np-soft">Le fichier <b>wiki-notion-….json</b> téléchargé par le collecteur.</span>`}</span></div>
      ${this.wiki ? "" : `<p class="np-soft">Pas encore de fichier ? <a data-act="collector">Installer le collecteur</a> (un favori à cliquer sur votre site Notion publié).</p>`}</div>`;
    if (!this.wiki) {
      el.innerHTML = fileCard;
      if (this.rendered) this.setPosition({ height: "auto" });
      return;
    }
    const { pages, parts } = plan(this.wiki, this.excluded);
    const entry = findEntry(this.wiki.root);
    const { added, changed, removed } = diff(this.wiki, pages, entry);
    const total = added.length + changed.length + removed.length;
    const names = list => list.slice(0, 8).map(x => `« ${esc(x)} »`).join(", ") + (list.length > 8 ? ` et ${list.length - 8} autres` : "");
    el.innerHTML = fileCard + `
      <div class="np-card"><h3>Changements</h3>
        <div class="np-stats">
          <div class="np-stat add"><b>${added.length}</b><span>nouvelle${added.length > 1 ? "s" : ""}</span></div>
          <div class="np-stat mod"><b>${changed.length}</b><span>modifiée${changed.length > 1 ? "s" : ""}</span></div>
          <div class="np-stat del"><b>${removed.length}</b><span>retirée${removed.length > 1 ? "s" : ""}</span></div>
        </div>
        ${removed.length ? `<p class="np-soft">Retirées de Foundry (et leurs épingles sur les scènes) : ${names(removed.map(pg => pg.name))}.</p>` : ""}
        ${added.length && entry ? `<p class="np-soft">Nouvelles : ${names(added.map(p => p.title))}. Elles seront visibles par les joueurs.</p>` : ""}
        ${!entry ? `<p class="np-soft">Premier import : un journal « Wiki · ${esc(this.wiki.rootTitle)} » est créé, visible par les joueurs (cachez une page avec l'œil de la bibliothèque).</p>` : ""}
      </div>
      <div class="np-card"><h3>Parties de la page d'accueil</h3>
        <div class="np-parts">${parts.map(p => `<label class="${this.excluded.has(p.key) ? "is-off" : ""}"><input type="checkbox" data-part="${esc(p.key)}"${this.excluded.has(p.key) ? "" : " checked"}>
          ${p.view ? `<i class="fa-solid fa-table-list"></i>` : `<i class="fa-regular fa-file-lines"></i>`}<span>${esc(p.label)}</span> <small>${p.count}</small></label>`).join("")}</div>
        <p class="np-soft">Décocher une partie en fait une <b>coulisse</b> : elle n'apparaît pas, mais ses pages restent si une vue les montre ailleurs (une base rangée dans « Backend » et affichée dans les pages des mondes, par exemple). Choix gardé pour les prochains imports.</p>
      </div>
      <div class="np-actions"><button type="button" class="np-btn ghost" data-act="cancel">Annuler</button>
        <button type="button" class="np-btn" data-act="apply"${total ? "" : " disabled"}><i class="fa-solid fa-check"></i>${total ? `Importer ${total} changement${total > 1 ? "s" : ""}` : "Rien à changer"}</button></div>`;
    if (this.rendered) this.setPosition({ height: "auto" });
  }

  async #apply() {
    if (this.#busy || !this.wiki) return;
    this.#busy = true;
    const wiki = this.wiki;
    try {
      const { pages } = plan(wiki, this.excluded);
      let entry = findEntry(wiki.root);
      if (!entry) {
        entry = await foundry.documents.JournalEntry.implementation.create({
          name: `Wiki · ${wiki.rootTitle}`,
          ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
          flags: { [ID]: { root: wiki.root, rootTitle: wiki.rootTitle } }
        });
      }
      const { added, changed, removed } = diff(wiki, pages, entry);
      // Ordre du journal : celui du sommaire (chemin puis titre).
      const order = new Map([...pages].sort((a, b) => sortKey(wiki, a).localeCompare(sortKey(wiki, b), "fr")).map((p, i) => [p.id, (i + 1) * 100]));
      order.set(wiki.root, 0);  // la page d'accueil en tête du journal
      if (removed.length) {
        const ids = new Set(removed.map(pg => pg.id));
        for (const scene of game.scenes) {
          const notes = scene.notes.filter(n => n.entryId === entry.id && ids.has(n.pageId)).map(n => n.id);
          if (notes.length) await scene.deleteEmbeddedDocuments("Note", notes);
        }
        await entry.deleteEmbeddedDocuments("JournalEntryPage", [...ids]);
      }
      if (changed.length) await entry.updateEmbeddedDocuments("JournalEntryPage", changed.map(({ p, pg }) => {
        const data = pageData(wiki, p, order.get(p.id));
        delete data.type;
        delete data.title;
        return { _id: pg.id, ...data };
      }));
      if (added.length) await entry.createEmbeddedDocuments("JournalEntryPage", added.map(p => pageData(wiki, p, order.get(p.id))));
      // Ordre du journal remis d'aplomb pour les pages inchangées aussi (pas compté dans le bilan).
      const resort = entry.pages.filter(pg => pg.type === TYPE && order.has(pg.system.notionId) && pg.sort !== order.get(pg.system.notionId))
        .map(pg => ({ _id: pg.id, sort: order.get(pg.system.notionId) }));
      if (resort.length) await entry.updateEmbeddedDocuments("JournalEntryPage", resort);
      await entry.update({
        [`flags.${ID}`]: { root: wiki.root, rootTitle: wiki.rootTitle, excluded: [...this.excluded], collectedAt: wiki.collectedAt, site: wiki.site }
      });
      ui.notifications.info(`Wiki Notion Integration : wiki importé (${added.length} nouvelles, ${changed.length} modifiées, ${removed.length} retirées).`);
      this.close();
    } catch (err) {
      console.error("Wiki Notion Integration | import", err);
      ui.notifications.error(`Wiki Notion Integration : l'import a échoué (${err.message}).`);
    } finally {
      this.#busy = false;
    }
  }
}

function sortKey(wiki, p) {
  const byId = new Map(wiki.pages.map(x => [x.id, x]));
  const parts = [];
  let cur = p, guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.title);
    const l = cur.locations[0];
    if (!l || l.parent === wiki.root) { if (l?.group) parts.unshift(l.group); break; }
    if (l.group) parts.unshift(l.group);
    cur = byId.get(l.parent);
  }
  return parts.join(" › ");
}

export function openImport() {
  if (!game.user.isGM) return;
  const app = foundry.applications.instances.get("np-import");
  if (app) return app.bringToFront();
  new ImportApp().render({ force: true });
}

/* ------------------------------------------------------------- collecteur */

export async function openCollector() {
  let code;
  try {
    code = await (await fetch(`modules/${ID}/scripts/collector.js`, { cache: "no-store" })).text();
  } catch (err) {
    return ui.notifications.error(`Wiki Notion Integration : collecteur introuvable (${err.message}).`);
  }
  const bookmarklet = `javascript:${encodeURIComponent(code.replace(/^\s*\/\/.*$/gm, "").trim())}`;
  await DialogV2.wait({
    window: { title: "Installer le collecteur", icon: "fa-solid fa-bookmark" },
    classes: ["notion-pages", "np-collector"],
    position: { width: 560 },
    content: `<div class="np-coll">
      <p>Le collecteur est un <b>favori</b> qui lit votre site Notion publié et télécharge le fichier à importer ici.
      À installer une seule fois, dans le navigateur où vous ouvrez Notion.</p>
      <p class="np-center"><a class="np-bookmarklet" draggable="true"><i class="fa-solid fa-book-open"></i>Collecter le wiki</a></p>
      <ol>
        <li><b>Glissez</b> ce bouton dans la barre de favoris (Ctrl+Maj+B pour l'afficher).<br>
        <span class="np-soft">Application Foundry ou glisser impossible : <a data-act="copy">copiez le code</a>, puis clic droit sur la barre de favoris → Ajouter une page → nom « Collecter le wiki », et collez le code à la place de l'adresse.</span></li>
        <li>Ouvrez la <b>page d'accueil</b> de votre wiki publié, cliquez sur le favori. Un cadre « Collecte en cours… » s'affiche, puis le fichier part dans vos téléchargements.</li>
        <li>Revenez ici : bouton <i class="fa-solid fa-gear"></i> de la bibliothèque → <b>Importer le wiki</b>.</li>
      </ol>
      <p class="np-soft">Seules les pages publiées sont lues. Si Notion change son fonctionnement interne, le collecteur devra être mis à jour (les pages déjà importées continuent de s'afficher).</p>
    </div>`,
    buttons: [{ action: "close", label: "Fermer", icon: "fa-solid fa-check", default: true }],
    render: (event, dialog) => {
      const root = dialog.element;
      // Posé après coup : DialogV2 nettoie son contenu et retire les liens « javascript: ».
      root.querySelector(".np-bookmarklet").setAttribute("href", bookmarklet);
      root.querySelector(".np-bookmarklet").addEventListener("click", e => {
        e.preventDefault();
        ui.notifications.info("Glissez ce bouton dans la barre de favoris : il se lance depuis votre site Notion, pas ici.");
      });
      root.querySelector("[data-act=copy]").addEventListener("click", async () => {
        await navigator.clipboard.writeText(bookmarklet);
        ui.notifications.info("Code du collecteur copié.");
      });
    }
  });
}

/* ------------------------------------------------------- page à la main */

const MANUAL_FLAG = "manual";

export async function openAddPage() {
  if (!game.user.isGM) return;
  const result = await DialogV2.input({
    window: { title: "Ajouter une page Notion", icon: "fa-solid fa-plus" },
    classes: ["notion-pages"],
    position: { width: 520 },
    content: `<div class="np-add">
      <div class="form-group"><label>Lien publié</label><div class="form-fields"><input type="url" name="link" required placeholder="https://monsite.notion.site/Ma-page-0123…"></div></div>
      <div class="form-group"><label>Titre</label><div class="form-fields"><input type="text" name="title" placeholder="Repris du lien si vide"></div></div>
      <div class="form-group"><label>Mots-clés</label><div class="form-fields"><input type="text" name="keywords" placeholder="taverne, Vogua, PNJ…"></div></div>
      <p class="hint">La page arrive dans le journal « Notion · pages ajoutées », visible par les joueurs.</p>
    </div>`,
    ok: { label: "Ajouter", icon: "fa-solid fa-plus" }
  });
  if (!result) return;
  const parsed = parseNotionUrl(result.link);
  if (!parsed) return ui.notifications.warn("Wiki Notion Integration : ce lien n'est pas un lien de page Notion (il doit finir par l'identifiant de 32 caractères).");
  let entry = game.journal.find(e => e.getFlag(ID, MANUAL_FLAG));
  entry ??= await foundry.documents.JournalEntry.implementation.create({
    name: "Notion · pages ajoutées",
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    flags: { [ID]: { [MANUAL_FLAG]: true } }
  });
  await entry.createEmbeddedDocuments("JournalEntryPage", [{
    name: String(result.title ?? "").trim() || titleFromUrl(result.link) || "Page Notion",
    type: TYPE,
    system: { site: parsed.site, notionId: parsed.id, keywords: String(result.keywords ?? "").trim() }
  }]);
  ui.notifications.info("Wiki Notion Integration : page ajoutée.");
}
