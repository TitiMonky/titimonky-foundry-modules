// Données de Wiki Notion Integration : le type de page de journal « Notion », l'index de recherche et l'arborescence du wiki.
export const ID = "wiki-notion-integration";
export const TYPE = `${ID}.notion`;

export const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const norm = value => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const shortId = id => String(id ?? "").replace(/-/g, "").toLowerCase();

/** Lien Notion → { site, id }. Accepte un lien publié (notion.site, domaine perso) ou un lien /ebd/. */
export function parseNotionUrl(link) {
  let url;
  try { url = new URL(String(link ?? "").trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const id = url.pathname.match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0]
    ?? url.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return id ? { site: url.origin, id: shortId(id) } : null;
}

/** Titre deviné depuis l'adresse (« Les-L-gendes-de-Meyiv-cc37… » → « Les L gendes de Meyiv ») : Notion retire les accents. */
export function titleFromUrl(link) {
  try {
    const last = decodeURIComponent(new URL(link).pathname.split("/").pop() ?? "");
    return last.replace(/-?[0-9a-f]{32}$/i, "").replace(/-/g, " ").trim();
  } catch { return ""; }
}

export class NotionPageData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      site: new f.StringField({ blank: true, initial: "" }),
      notionId: new f.StringField({ blank: true, initial: "" }),
      icon: new f.StringField({ blank: true, initial: "" }),
      keywords: new f.StringField({ blank: true, initial: "" }),
      // Rempli par l'import : texte et propriétés Notion, pour la recherche ; emplacements (page parente + vue).
      text: new f.StringField({ blank: true, initial: "" }),
      props: new f.ArrayField(new f.StringField()),
      locations: new f.ArrayField(new f.SchemaField({
        parent: new f.StringField({ blank: true, initial: "" }),
        group: new f.StringField({ blank: true, nullable: true, initial: null })
      })),
      wiki: new f.StringField({ blank: true, initial: "" }),
      edited: new f.NumberField({ nullable: true, initial: null })
    };
  }

  get embedUrl() { return this.site && this.notionId ? `${this.site}/ebd/${this.notionId}` : ""; }
  get publicUrl() { return this.site && this.notionId ? `${this.site}/${this.notionId}` : ""; }
}

/* ------------------------------------------------------------------ droits */

const LEVELS = () => CONST.DOCUMENT_OWNERSHIP_LEVELS;

/** La page est-elle visible par les joueurs (droit par défaut, celui que règle l'œil) ? */
export function playersCanSee(page) {
  const own = page.ownership?.default ?? LEVELS().INHERIT;
  const level = own === LEVELS().INHERIT ? (page.parent?.ownership?.default ?? LEVELS().NONE) : own;
  return level >= LEVELS().OBSERVER;
}

/** L'œil : cachée = aucun droit par défaut sur la page ; visible = elle suit son journal (Observateur à l'import). */
export async function setPlayersCanSee(page, visible) {
  const { INHERIT, NONE, OBSERVER } = LEVELS();
  const entryLevel = page.parent?.ownership?.default ?? NONE;
  const value = visible ? (entryLevel >= OBSERVER ? INHERIT : OBSERVER) : NONE;
  await page.update({ "ownership.default": value });
}

export const canView = page => game.user.isGM || page.testUserPermission(game.user, "OBSERVER");

/* ------------------------------------------------- à la une, favoris */

// À la une : choisie par le MJ, la même pour toute la table (réglage monde, la plus récente en tête).
// Favoris : à chacun (flag de l'utilisateur, il le suit d'un ordinateur à l'autre).
export const featuredUuids = () => game.settings.get(ID, "featured") ?? [];
export const favoriteUuids = () => game.user.getFlag(ID, "favorites") ?? [];

const toggled = (list, uuid) => list.includes(uuid) ? list.filter(u => u !== uuid) : [uuid, ...list];
export async function toggleFeatured(page) {
  if (game.user.isGM) await game.settings.set(ID, "featured", toggled(featuredUuids(), page.uuid));
}
export async function toggleFavorite(page) {
  await game.user.setFlag(ID, "favorites", toggled(favoriteUuids(), page.uuid));
}

/* ------------------------------------------------------------------- index */

let cache = null;
export const invalidate = () => { cache = null; };

/** Les pages Notion que l'utilisateur peut lire, avec leurs textes normalisés et l'arborescence. Recalculé à la demande. */
export function getIndex() {
  if (cache) return cache;
  const items = [];
  const wikis = [];
  for (const entry of game.journal) {
    const root = entry.getFlag(ID, "root");
    if (root) wikis.push({ root, entry, title: entry.getFlag(ID, "rootTitle") || entry.name });
    for (const page of entry.pages) {
      if (page.type !== TYPE || !canView(page)) continue;
      const s = page.system;
      items.push({
        page, uuid: page.uuid, nid: s.notionId || page.id, title: page.name, icon: s.icon,
        wiki: s.wiki, locs: s.locations.filter(l => l.parent),
        hidden: game.user.isGM && !playersCanSee(page),
        nt: norm(page.name), nk: norm(s.keywords), nx: norm(`${s.props.join(" · ")}\n${s.text}`),
        excerptSource: `${s.keywords ? s.keywords + " · " : ""}${s.props.join(" · ")}\n${s.text}`.trim().replace(/\s+/g, " ")
      });
    }
  }
  const byNid = new Map(items.map(i => [i.nid, i]));
  const kids = new Map();
  for (const item of items) for (const l of item.locs) {
    if (!kids.has(l.parent)) kids.set(l.parent, []);
    kids.get(l.parent).push(item.nid);
  }
  const rootIds = new Set(wikis.map(w => w.root));
  for (const item of items) item.path = crumbs(item, byNid, rootIds);
  // Une page cachée aux joueurs n'est pas dans leurs items : elle disparaît aussi de leur « À la une ».
  const byUuid = new Map(items.map(i => [i.uuid, i]));
  const featured = featuredUuids().map(u => byUuid.get(u)).filter(Boolean);
  const favorites = favoriteUuids().map(u => byUuid.get(u)).filter(Boolean);
  for (const i of featured) i.featured = true;
  for (const i of favorites) i.favorite = true;
  cache = { items, byNid, kids, featured, favorites, wikis: wikis.filter(w => byNid.has(w.root) || kids.has(w.root)) };
  return cache;
}

// Chemin du premier emplacement : « Genèsios › Meyiv › Meyiv : Divinités ».
function crumbs(item, byNid, rootIds, guard = 0) {
  const l = item.locs[0];
  if (!l || guard > 15) return [];
  const here = l.group ? [l.group] : [];
  const parent = byNid.get(l.parent);
  if (rootIds.has(l.parent) || !parent) return here;
  return [...crumbs(parent, byNid, rootIds, guard + 1), parent.title, ...here];
}

/* ---------------------------------------------------------------- arbre */

// Nœuds : « p|<id> » = une page, « g|<id page>|<vue> » = une vue (ou base) affichée dans cette page, « m » = pages
// ajoutées à la main (sans emplacement).
export function nodeKids(index, pid) {
  const groups = new Map(), subs = new Set();
  for (const nid of index.kids.get(pid) ?? []) for (const l of index.byNid.get(nid).locs) {
    if (l.parent !== pid) continue;
    if (l.group) {
      if (!groups.has(l.group)) groups.set(l.group, new Set());
      groups.get(l.group).add(nid);
    } else subs.add(nid);
  }
  return { groups, subs };
}

/** Pages d'une branche (sans la page du nœud elle-même). */
export function subtree(index, key, acc = new Set()) {
  if (key === "m") {
    for (const i of index.items) if (!i.locs.length && !index.wikis.some(w => w.root === i.nid)) acc.add(i.nid);
    return acc;
  }
  const [kind, pid, group] = key.split("|");
  const { groups, subs } = nodeKids(index, pid);
  const ids = kind === "g" ? [...(groups.get(group) ?? [])] : [...[...groups.values()].flatMap(s => [...s]), ...subs];
  for (const nid of ids) if (!acc.has(nid)) { acc.add(nid); subtree(index, `p|${nid}`, acc); }
  return acc;
}

/** Enfants affichés dans le sommaire : vues et pages qui contiennent quelque chose (les autres sont dans les résultats). */
export function childNodes(index, key) {
  const [kind, pid, group] = key.split("|");
  const { groups, subs } = nodeKids(index, pid);
  const pageNode = nid => ({ key: `p|${nid}`, label: index.byNid.get(nid).title, emoji: index.byNid.get(nid).icon });
  if (kind === "g") return [...(groups.get(group) ?? [])].filter(nid => index.kids.has(nid)).map(pageNode);
  return [
    ...[...groups.keys()].map(g => ({ key: `g|${pid}|${g}`, label: g, view: true })),
    ...[...subs].filter(nid => index.kids.has(nid)).map(pageNode)
  ];
}

/* --------------------------------------------------------------- recherche */

const terms = query => norm(query).split(/\s+/).filter(Boolean);

/** Résultats triés : titre (début de mot > ailleurs) > mots-clés > emplacement > texte. Tous les mots doivent figurer. */
export function search(index, query, filter = null) {
  const words = terms(query);
  const list = filter ? index.items.filter(filter) : index.items;
  if (!words.length) return [...list].sort((a, b) => a.title.localeCompare(b.title, "fr"));
  const scored = [];
  for (const item of list) {
    let score = 0;
    const where = norm(item.path.join(" "));
    for (const w of words) {
      const s = (item.nt.startsWith(w) ? 14 : new RegExp(`(^|[^a-z0-9])${escapeRegExp(w)}`).test(item.nt) ? 11 : item.nt.includes(w) ? 7 : 0)
        + (item.nk.includes(w) ? 6 : 0) + (where.includes(w) ? 3 : 0) + (item.nx.includes(w) ? 1 : 0);
      if (!s) { score = 0; break; }
      score += s;
    }
    if (score) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "fr")).map(s => s.item);
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Texte surligné (sans tenir compte des accents) : on repère les positions sur le texte normalisé, de même longueur. */
export function highlight(text, query) {
  const words = terms(query);
  const source = String(text ?? "");
  if (!words.length) return esc(source);
  const n = norm(source);
  if (n.length !== source.length) return esc(source);
  const marks = new Array(source.length).fill(false);
  for (const w of words) {
    let i = -1;
    while ((i = n.indexOf(w, i + 1)) !== -1) for (let k = i; k < i + w.length; k++) marks[k] = true;
  }
  let out = "", on = false;
  for (let i = 0; i < source.length; i++) {
    if (marks[i] !== on) { out += marks[i] ? "<mark>" : "</mark>"; on = marks[i]; }
    out += esc(source[i]);
  }
  return out + (on ? "</mark>" : "");
}

/** Extrait de 180 caractères, centré sur le premier mot trouvé. */
export function excerpt(item, query) {
  const text = item.excerptSource;
  const n = norm(text);
  let at = 0;
  for (const w of terms(query)) {
    const i = n.indexOf(w);
    if (i > 0) { at = Math.max(0, i - 40); break; }
  }
  return (at ? "…" : "") + text.slice(at, at + 180);
}
