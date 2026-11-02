// Collecteur du wiki Notion : tourne en favori (bookmarklet) sur la page publiée ouverte, pas dans Foundry.
// Pourquoi ici : notion.site ne renvoie pas d'en-tête CORS, Foundry ne peut donc pas lire le site ; la page publiée,
// elle, peut interroger sa propre API. On part de la page ouverte, on suit les sous-pages et les bases publiées, et on
// télécharge un JSON que le module importe. Ce qui n'est pas publié ne répond pas : il est ignoré d'office.
// API interne de Notion (non documentée) : si Notion la change, c'est ce fichier qu'il faut adapter.
(async () => {
  const FORMAT = "notion-pages-wiki";
  const MAX_TEXT = 30000;
  const PARALLEL = 4;

  if (window.__notionPagesCollecting) return;
  const rootId = toUuid(location.pathname.match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0]);
  if (!/\.notion\.site$|notion\.so$/.test(location.hostname) && !document.querySelector(".notion-app")) {
    alert("Collecter le wiki : ouvrez d'abord votre page Notion publiée (la page d'accueil du wiki), puis cliquez sur ce favori.");
    return;
  }
  if (!rootId) {
    alert("Collecter le wiki : impossible de trouver l'identifiant de la page dans l'adresse. Ouvrez la page d'accueil du wiki.");
    return;
  }
  window.__notionPagesCollecting = true;

  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:12px 14px;"
    + "border-radius:8px;background:#1b1b1e;color:#f2f2f3;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px #0008;"
    + "border:1px solid #cfa95e";
  document.body.append(box);
  const say = html => { box.innerHTML = `<b style="color:#e3bd6b">Wiki Notion Integration</b><br>${html}`; };
  say("Collecte en cours…");

  function toUuid(raw) {
    if (!raw) return null;
    const h = raw.replace(/-/g, "").toLowerCase();
    return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
  }
  // Notion range parfois les blocs sous value.value (avec le rôle), parfois directement sous value.
  const unwrap = rec => rec?.value?.value ?? rec?.value ?? null;
  const richText = prop => Array.isArray(prop) ? prop.map(part => part[0] === "‣" ? "" : part[0]).join("") : "";
  const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  async function api(endpoint, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`/api/v3/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      // Notion limite le débit : on attend et on réessaie quelques fois.
      if (res.status === 429 && attempt < 5) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`${endpoint} : HTTP ${res.status}`);
      return res.json();
    }
  }

  async function loadPage(id) {
    const blocks = {}, collections = {}, views = {};
    let cursor = { stack: [] };
    for (let chunk = 0; chunk < 50; chunk++) {
      const data = await api("loadPageChunk", { pageId: id, limit: 100, cursor, chunkNumber: chunk, verticalColumns: false });
      Object.assign(blocks, data.recordMap?.block ?? {});
      Object.assign(collections, data.recordMap?.collection ?? {});
      Object.assign(views, data.recordMap?.collection_view ?? {});
      cursor = data.cursor;
      if (!cursor?.stack?.length) break;
    }
    return { blocks, collections, views };
  }

  // Les filtres d'une vue ne sont pas appliqués d'office par l'API : on les repasse (format.property_filters, et
  // query2.filter pour les anciennes vues). Sans eux, une vue liée « Meyiv : Régions » rendait tous les lieux.
  function viewFilter(view) {
    const filters = (view?.format?.property_filters ?? [])
      .map(f => f.filter?.property && f.filter.filter ? { property: f.filter.property, filter: f.filter.filter } : null)
      .filter(Boolean);
    if (view?.query2?.filter?.filters?.length) filters.push(view.query2.filter);
    return filters.length ? { operator: "and", filters } : undefined;
  }

  async function queryRows(collectionId, viewId, spaceId, filter) {
    const data = await api("queryCollection?src=reset", {
      source: { type: "collection", id: collectionId, spaceId },
      collectionView: { id: viewId, spaceId },
      loader: {
        type: "reducer", searchQuery: "", userTimeZone: "Europe/Paris", filter,
        reducers: { collection_group_results: { type: "results", limit: 999 } }
      }
    });
    const ids = data.result?.reducerResults?.collection_group_results?.blockIds ?? [];
    return { ids, blocks: data.recordMap?.block ?? {}, collections: data.recordMap?.collection ?? {} };
  }

  const pages = new Map();   // id → page collectée
  const queue = [{ id: rootId, parent: null, group: null }];
  const seen = new Set([rootId]);
  const errors = [];

  // Une même page peut apparaître à plusieurs endroits (base d'origine + vues liées ailleurs) : on garde tous ses
  // emplacements, l'import choisit (une base rangée dans une page exclue ne doit pas emporter ses lignes).
  const locations = {};
  function enqueue(id, parent, group) {
    if (!id) return;
    const list = locations[id] ??= [];
    if (parent && !list.some(l => l.parent === parent && l.group === group)) list.push({ parent, group });
    if (seen.has(id)) return;
    seen.add(id);
    queue.push({ id, parent, group });
  }

  // Une base ou une vue liée : ses lignes sont des pages enfants de la page qui l'affiche. Un wiki peut stocker ses
  // bases dans une page « coulisses » et les montrer ailleurs par des vues liées filtrées (cas du wiki de Meyiv) :
  // chaque vue compte comme un emplacement, rangé sous son nom (« Meyiv : Régions ») ; une base d'origine, sous le
  // nom de la base. Une vue liée n'a pas de collection_id : le pointeur est sur la vue.
  async function visitCollection(block, pageId, { collections, views }) {
    const extra = [];
    for (const viewId of block.view_ids ?? []) {
      const view = unwrap(views[viewId]);
      const linked = !block.collection_id;
      const collectionId = block.collection_id ?? block.format?.collection_pointer?.id ?? view?.format?.collection_pointer?.id;
      if (!collectionId) continue;
      try {
        const rows = await queryRows(collectionId, viewId, block.space_id, viewFilter(view));
        const coll = unwrap(collections[collectionId] ?? rows.collections[collectionId]);
        const group = (linked && view?.name?.trim()) || richText(coll?.name) || null;
        const schema = coll?.schema ?? {};
        for (const rowId of rows.ids) {
          const row = unwrap(rows.blocks[rowId]);
          if (!row || row.alive === false) continue;
          // Les propriétés de la ligne (étiquettes, lieu…) servent à la recherche.
          // Une relation vers des pages se lit « , » (mentions retirées) : sans valeur, on l'écarte.
          const props = Object.entries(row.properties ?? {}).filter(([k]) => k !== "title")
            .map(([k, v]) => [schema[k]?.name?.trim(), richText(v).trim()]).filter(([, v]) => v && !/^[\s,]*$/.test(v))
            .map(([name, v]) => name ? `${name} : ${v}` : v);
          extra.push({ rowId, props });
          enqueue(rowId, pageId, group);
        }
      } catch (err) {
        errors.push(`Base ${collectionId} (vue ${viewId}) : ${err.message}`);
      }
    }
    return extra;
  }

  async function visit({ id, parent, group }) {
    let loaded;
    try { loaded = await loadPage(id); } catch (err) { errors.push(`${id} : ${err.message}`); return; }
    const { blocks } = loaded;
    const page = unwrap(blocks[id]);
    if (!page || page.alive === false) return;  // non publiée ou supprimée
    const title = richText(page.properties?.title) || "Sans titre";
    const lines = [];

    // Parcours du contenu de la page, sans descendre dans les sous-pages (elles sont visitées pour elles-mêmes).
    const walk = async ids => {
      for (const bid of ids ?? []) {
        const b = unwrap(blocks[bid]);
        if (!b || b.alive === false) continue;
        if (b.type === "page") { enqueue(bid, id, null); continue; }
        if (b.type === "collection_view" || b.type === "collection_view_page") {
          rowProps.push(...await visitCollection(b, id, loaded));
          continue;
        }
        const text = richText(b.properties?.title);
        if (text) lines.push(text);
        if (b.content?.length) await walk(b.content);
      }
    };
    const rowProps = [];
    if (page.type === "collection_view_page") rowProps.push(...await visitCollection(page, id, loaded));
    else await walk(page.content);

    pages.set(id, {
      id, title, parent, group,
      icon: typeof page.format?.page_icon === "string" && !page.format.page_icon.startsWith("http") ? page.format.page_icon : null,
      edited: page.last_edited_time ?? null,
      text: lines.join("\n").slice(0, MAX_TEXT)
    });
    // Les propriétés d'une ligne de base sont rangées sur la page de la ligne, qu'elle soit déjà visitée ou pas.
    for (const { rowId, props } of rowProps) if (props.length) (pending[rowId] ??= []).push(...props);
  }
  const pending = {};

  try {
    while (queue.length) {
      const batch = queue.splice(0, PARALLEL);
      await Promise.all(batch.map(visit));
      say(`Collecte en cours… <b>${pages.size}</b> page${pages.size > 1 ? "s" : ""}<br>`
        + `<span style="color:#a8a8ae">${esc([...pages.values()].at(-1)?.title ?? "")}</span>`);
    }
    for (const [rowId, props] of Object.entries(pending)) {
      const page = pages.get(rowId);
      if (page) page.props = [...new Set(props)];
    }
    for (const page of pages.values()) page.locations = (locations[page.id] ?? []).filter(l => pages.has(l.parent));
    if (!pages.has(rootId)) throw new Error("la page ouverte n'est pas publiée (ou n'a pas pu être lue)");

    const root = pages.get(rootId);
    const result = {
      format: FORMAT, version: 1,
      site: location.origin, root: rootId, rootTitle: root.title,
      collectedAt: new Date().toISOString(),
      pages: [...pages.values()]
    };
    const blob = new Blob([JSON.stringify(result)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `wiki-notion-${root.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "export"}.json`
    });
    document.body.append(a);
    a.click();
    a.remove();
    say(`Terminé : <b>${pages.size}</b> pages collectées depuis « ${esc(root.title)} ».<br>`
      + `Le fichier est dans vos téléchargements : importez-le dans Foundry (bibliothèque Wiki → rouage → Importer le wiki).`
      + (errors.length ? `<br><span style="color:#e8a0a0">${errors.length} élément(s) illisible(s) ignoré(s).</span>` : ""));
    window.__notionPagesResult = result;
    window.__notionPagesErrors = errors;
  } catch (err) {
    say(`<span style="color:#e8a0a0">Échec de la collecte : ${esc(err.message)}</span>`);
    console.error("Wiki Notion Integration", err, errors);
    window.__notionPagesFail = String(err);
  } finally {
    window.__notionPagesCollecting = false;
    setTimeout(() => box.remove(), 20000);
  }
})();
