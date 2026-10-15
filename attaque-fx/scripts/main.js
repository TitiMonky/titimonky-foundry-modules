import { RECIPES, RESULT_FX, STATUS_FX } from "./recipes.js";

const MODULE_ID = "attaque-fx";
/** Noms des effets persistants : lancés à la main (fenêtre) ou liés à un état. */
const MANUAL_PREFIX = "afx:";
const STATUS_PREFIX = "afx-etat:";

const RESULTS = {
  hit: "Touché",
  crit: "Critique",
  miss: "Raté",
  blocked: "Bloqué"
};

const DEFAULT_OPTIONS = {
  mode: "recipes",
  animation: "sword",
  result: "hit",
  camera: true,
  darken: true,
  bars: false,
  resultText: true,
  libCategory: "all",
  libSearch: "",
  libFile: "",
  libKind: "projectile",
  libImpact: "",
  duration: "normal",
  durationSeconds: 30
};

const DURATIONS = {
  normal: "Normale",
  long: "Longue",
  persist: "Permanente"
};

/** Valeur d'animation qui désigne une entrée choisie dans la bibliothèque. */
const LIBRARY_ID = "__library";
const LIBRARY_LIMIT = 800;

const KINDS = {
  melee: "Mêlée (du lanceur vers la cible)",
  projectile: "Projectile / rayon (du lanceur vers la cible)",
  onTarget: "Sur la cible",
  heal: "Soin (sur la cible, sans résultat)",
  aura: "Aura / effet accroché au token (sans résultat)"
};

/** Types sans notion de touché / raté. */
const NO_RESULT = new Set(["heal", "aura"]);

/**
 * Catégories de la bibliothèque, déduites du dossier du fichier dans
 * JB2A (".../Library/<dossier>/..."). Une entrée peut être dans plusieurs.
 */
const CATEGORIES = [
  { id: "all", label: "Tout" },
  { id: "melee", label: "Corps à corps", icon: "fa-hand-fist", test: f => /^Generic\/(Weapon_Attacks\/Melee|Unarmed_Attacks|Creature)\//.test(f) },
  { id: "ranged", label: "Distance", icon: "fa-bullseye", test: f => /^Generic\/Weapon_Attacks\/Ranged\//.test(f) },
  { id: "spells", label: "Sorts", icon: "fa-hat-wizard", test: f => /^(Cantrip|\d\w+_Level)\//.test(f) },
  { id: "magic", label: "Projectiles magiques", icon: "fa-wand-sparkles", test: f => /^Generic\/RangedSpell\//.test(f) },
  { id: "elements", label: "Éléments", icon: "fa-fire", test: f => /^Generic\/(Fire|Ice|Lightning|Lava|Liquid|Wind|Nature|Energy|Smoke|Fog)\//.test(f) },
  { id: "impacts", label: "Impacts & explosions", icon: "fa-burst", test: f => /^Generic\/(Impact|Explosion)\//.test(f) },
  { id: "heal", label: "Soins", icon: "fa-heart", test: f => /^Generic\/Healing\/|\/Cure_Wounds\//.test(f) },
  { id: "cast", label: "Incantation & runes", icon: "fa-sun", test: f => /^Generic\/(Cast|Magic_Signs)\//.test(f) },
  { id: "token", label: "Sur le token", icon: "fa-circle-user", test: f => /^Generic\/(On_Token|Conditions|Token_Border|Token_Stage|Particles|Marker)\//.test(f) },
  { id: "zones", label: "Zones & pièges", icon: "fa-circle-dot", test: f => /^Generic\/(Template|Zoning|Traps|Portals)\//.test(f) },
  { id: "other", label: "Divers", icon: "fa-shapes" }
];

const escape = str => String(str ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[c]);

/* -------------------------------------------- */
/*  Banque                                      */
/* -------------------------------------------- */

const entryExists = path => !path || Sequencer.Database.entryExists(path);

/** Recettes dont tous les fichiers existent dans la base Sequencer. */
function availableRecipes() {
  return RECIPES.filter(r => [r.file, r.cast, r.impact].every(entryExists));
}

function previewFile(path) {
  if (!path || !Sequencer.Database.entryExists(path)) return "";
  const files = Sequencer.Database.getAllFileEntries(path) ?? [];
  return files.find(f => f.includes("30ft")) ?? files[0] ?? "";
}

let library;

/**
 * Toutes les entrées jb2a.* de Sequencer (gratuit + Patreon fusionnés),
 * sans les variantes de distance (.30ft…) ni les index de tableau.
 * Chaque entrée : { path, group, label, ranged, weapon, cats }.
 * `ranged` : l'entrée a des variantes de distance, elle est donc faite pour
 * aller du lanceur à la cible. `weapon` : attaque d'arme ou à mains nues.
 */
function getLibrary() {
  if (library) return library;
  const byPath = new Map();
  for (const { path, file } of Sequencer.Database.publicFlattenedEntriesAdvanced) {
    if (!path.startsWith("jb2a.") || path.includes("._") || typeof file !== "string" || !file.includes("/")) continue;
    const bare = path.replace(/\.[0-9]$/, "");
    const simple = bare.split(/\.[0-9]+ft/)[0];
    let item = byPath.get(simple);
    if (!item) {
      const [, group, ...rest] = simple.split(".");
      item = { path: simple, group, label: rest.join(".") || group, ranged: false, weapon: false, cats: new Set() };
      byPath.set(simple, item);
    }
    if (simple !== bare) item.ranged = true;
    const folder = file.split("/Library/")[1] ?? "";
    if (/^Generic\/(Weapon_Attacks\/Melee|Unarmed_Attacks)\//.test(folder)) item.weapon = true;
    for (const c of CATEGORIES) if (c.test?.(folder)) item.cats.add(c.id);
  }
  const entries = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  for (const item of entries) {
    if (!item.cats.size) item.cats.add("other");
    item.cats.add("all");
  }
  const counts = Object.fromEntries(CATEGORIES.map(c => [c.id, entries.filter(e => e.cats.has(c.id)).length]));
  library = {
    entries,
    byPath,
    counts,
    impacts: entries.filter(e => e.cats.has("impacts")).map(e => e.path)
  };
  return library;
}

function searchLibrary(category, query) {
  const terms = query.toLowerCase().split(/[\s.]+/).filter(Boolean);
  return getLibrary().entries.filter(e => e.cats.has(category) && terms.every(t => e.path.includes(t)));
}

/** Type proposé selon l'entrée : variantes de distance → du lanceur vers la cible. */
function suggestKind(path) {
  const item = getLibrary().byPath.get(path);
  if (!item) return "projectile";
  if (item.cats.has("heal")) return "heal";
  if (item.weapon) return "melee";
  if (item.ranged) return "projectile";
  if (item.cats.has("token") && /loop|marker|aura|shield|ward/.test(path)) return "aura";
  return "onTarget";
}

/** Recette construite à la volée à partir d'une entrée de la bibliothèque. */
function libraryRecipe({ libFile, libKind, libImpact }) {
  return {
    id: LIBRARY_ID,
    label: libFile,
    kind: KINDS[libKind] ? libKind : "projectile",
    file: libFile,
    impact: libImpact || undefined,
    scale: 1.8
  };
}

/* -------------------------------------------- */
/*  Lecture                                     */
/* -------------------------------------------- */

const resolveToken = t => typeof t === "string" ? canvas.tokens.get(t) : (t?.object ?? t);

/**
 * Joue une attaque chez tous les joueurs.
 * @param {object} params
 * @param {Token|string} params.source      token lanceur (ou son id)
 * @param {Array<Token|string>} params.targets
 * @param {string|object} params.animation   id de la recette (voir recipes.js), ou une recette
 *                                           complète ({ kind, file, impact… }) pour une entrée libre
 * @param {"hit"|"crit"|"miss"|"blocked"} [params.result]
 * @param {"normal"|"long"|"persist"} [params.duration]  durée des effets joués sur le token (la cible peut être
 *                                           le lanceur lui-même) : longue = durationSeconds, permanente = jusqu'au retrait
 */
async function play({ source, targets, animation, result = "hit", camera = true, darken = true, bars = false, resultText = true,
  duration = "normal", durationSeconds = 30 }) {
  source = resolveToken(source);
  targets = (targets ?? Array.from(game.user.targets)).map(resolveToken).filter(Boolean);
  const recipe = typeof animation === "object" ? animation : RECIPES.find(r => r.id === animation);
  if (recipe && (!recipe.file || ![recipe.file, recipe.cast, recipe.impact].every(entryExists))) {
    ui.notifications.warn(`Attaque FX : animation introuvable dans Sequencer (${recipe.file || "aucune choisie"}).`);
    return;
  }
  if (!source || !targets.length || !recipe) {
    ui.notifications.warn("Attaque FX : il faut un lanceur, au moins une cible et une animation.");
    return;
  }
  if (NO_RESULT.has(recipe.kind)) result = "hit";

  const count = recipe.count ?? 1;
  const stagger = 350;
  const totalDuration = 3500 + stagger * (targets.length - 1) + 200 * (count - 1) + (result === "crit" ? 800 : 0);

  // Mise en scène commune : fond assombri, caméra, bandes cinéma, son.
  const scene = new Sequence(MODULE_ID);
  let hasScene = false;
  if (darken) {
    const { width, height } = canvas.dimensions;
    scene.effect()
      .shape("circle", { radius: Math.hypot(width, height), fillColor: 0x000000, fillAlpha: 1 })
      .atLocation({ x: width / 2, y: height / 2 })
      .opacity(0.5)
      .fadeIn(300)
      .fadeOut(500)
      .duration(totalDuration)
      .belowTokens();
    hasScene = true;
  }
  if (camera) {
    const { center, scale } = framing([source, ...targets]);
    scene.canvasPan().atLocation(center).scale(scale);
    hasScene = true;
  }
  if (recipe.sound) {
    scene.sound().file(recipe.sound);
    hasScene = true;
  }
  if (hasScene) scene.play();

  if (bars && globalThis.aerisBars?.beginCinematicForEveryone) {
    try { globalThis.aerisBars.beginCinematicForEveryone(totalDuration); }
    catch (err) { console.warn(`${MODULE_ID} | Bandes cinéma Aeris indisponibles`, err); }
  }

  targets.forEach((target, i) => {
    const seq = new Sequence(MODULE_ID);
    if (i > 0) seq.wait(i * stagger);
    buildAttack(seq, recipe, source, target, { result, resultText, withCast: i === 0, duration, durationSeconds });
    seq.play();
  });
}

function buildAttack(seq, recipe, source, target, { result, resultText, withCast, duration = "normal", durationSeconds = 30 }) {
  const miss = result === "miss";
  const crit = result === "crit";
  const count = recipe.count ?? 1;
  const self = target === source;
  // Sur soi-même, une arme ou un projectile se joue directement sur le token.
  const ranged = !self && (recipe.kind === "melee" || recipe.kind === "projectile");
  const noResult = NO_RESULT.has(recipe.kind);
  const lasting = !ranged && duration !== "normal";

  if (recipe.cast && withCast && !self) {
    seq.effect().file(recipe.cast).atLocation(source).scaleToObject(1.6);
    seq.wait(400);
  }

  const impactAt = recipe.impactAt ?? { melee: -1100, projectile: -500, onTarget: -800, heal: 0, aura: 0 }[recipe.kind];
  for (let k = 0; k < (lasting ? 1 : count); k++) {
    const effect = seq.effect().file(recipe.file);
    if (ranged) {
      effect.atLocation(source).stretchTo(target, count > 1 ? { randomOffset: recipe.spread ? 1 : 0.5 } : {});
    } else {
      if (lasting) lastingEffect(effect, target, recipe.label, duration, durationSeconds);
      else effect.atLocation(target);
      effect.scaleToObject(recipe.scale ?? 1.5);
      if (recipe.offsetY) effect.spriteOffset({ x: 0, y: recipe.offsetY }, { gridUnits: true });
      if (recipe.below) effect.belowTokens();
    }
    if (!noResult && !lasting) effect.missed(miss);
    if (k > 0) effect.delay(k * (recipe.spread ? 60 : 200));
    if (k === count - 1 && !noResult && !lasting) effect.waitUntilFinished(impactAt);
  }
  if (noResult) return;

  if (result === "blocked") {
    seq.effect().file(RESULT_FX.blockImpact).atLocation(target).scaleToObject(1.4);
    seq.effect().file(RESULT_FX.block).atLocation(target).scaleToObject(1.8);
  } else if (!miss && recipe.impact) {
    seq.effect()
      .file(recipe.impact)
      .atLocation(target)
      .scaleToObject((recipe.impactScale ?? 1.4) * (crit ? 1.5 : 1))
      .randomRotation();
  }

  if (crit) {
    seq.effect().file(RESULT_FX.critGround).atLocation(target).scaleToObject(2.5).belowTokens().fadeOut(800);
    seq.canvasPan().shake({ duration: 600, strength: 15, rotation: false, fadeOutDuration: 300 });
  }

  if (resultText && (crit || miss)) {
    seq.effect()
      .file(crit ? RESULT_FX.critText : RESULT_FX.missText)
      .atLocation(target)
      .spriteOffset({ x: 0, y: -0.8 }, { gridUnits: true })
      .scaleToObject(1.2);
  }
}

/**
 * Effet qui dure : accroché au token (il le suit), long (n secondes, la vidéo boucle) ou permanent
 * (enregistré par Sequencer sur le token, reste après un rechargement, retiré depuis la fenêtre).
 */
function lastingEffect(effect, token, label, duration, seconds) {
  effect.attachTo(token, { bindVisibility: true })
    .name(`${MANUAL_PREFIX}${label}`)
    .origin(MODULE_ID)
    .fadeIn(400)
    .fadeOut(600);
  if (duration === "persist") effect.persist();
  else effect.duration(Math.max(1, Number(seconds) || 30) * 1000);
  return effect;
}

/** Effets permanents lancés depuis la fenêtre, sur la scène courante : [{ effect, label, token }]. */
function manualEffects() {
  return Sequencer.EffectManager.getEffects({ origin: MODULE_ID, sceneId: canvas.scene?.id })
    .filter(e => e.data?.name?.startsWith(MANUAL_PREFIX))
    .map(e => ({
      effect: e,
      label: e.data.name.slice(MANUAL_PREFIX.length),
      token: e.sourceDocument?.name ?? e.source?.document?.name ?? e.source?.name ?? "?"
    }))
    .sort((a, b) => a.token.localeCompare(b.token) || a.label.localeCompare(b.label));
}

/** Centre et zoom pour cadrer tous les tokens concernés. */
function framing(tokens) {
  const xs = tokens.map(t => t.center.x);
  const ys = tokens.map(t => t.center.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = canvas.grid.size * 4;
  const scale = Math.min(
    window.innerWidth / (maxX - minX + pad),
    window.innerHeight / (maxY - minY + pad),
    1.2
  );
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    scale: Math.clamp(scale, 0.3, 1.2)
  };
}

/* -------------------------------------------- */
/*  Fenêtre                                     */
/* -------------------------------------------- */

async function openDialog(source) {
  source = resolveToken(source) ?? canvas.tokens.controlled[0];
  if (!source) return ui.notifications.warn("Attaque FX : sélectionne d'abord le token qui attaque.");

  const recipes = availableRecipes();
  if (!recipes.length) return ui.notifications.error("Attaque FX : aucune animation JB2A trouvée. JB2A est-il activé ?");

  const last = { ...DEFAULT_OPTIONS, ...game.settings.get(MODULE_ID, "last") };
  if (last.animation === LIBRARY_ID) last.mode = "library"; // réglage enregistré par la v1.1.0
  const current = recipes.some(r => r.id === last.animation) ? last.animation : recipes[0].id;
  const lib = getLibrary();
  if (!lib.counts[last.libCategory]) last.libCategory = "all";

  const groups = Object.groupBy(recipes, r => r.group);
  const animationSelect = Object.entries(groups).map(([group, list]) => `
    <optgroup label="${escape(group)}">
      ${list.map(r => `<option value="${r.id}" ${r.id === current ? "selected" : ""}>${escape(r.label)}</option>`).join("")}
    </optgroup>`).join("");

  const tab = (value, icon, label) => `
    <label class="afx-tab">
      <input type="radio" name="mode" value="${value}" ${last.mode === value ? "checked" : ""}>
      <span><i class="fa-solid ${icon}"></i> ${label}</span>
    </label>`;

  const chips = CATEGORIES.filter(c => lib.counts[c.id]).map(c => `
    <label class="afx-chip">
      <input type="radio" name="libCategory" value="${c.id}" ${last.libCategory === c.id ? "checked" : ""}>
      <span>${c.icon ? `<i class="fa-solid ${c.icon}"></i> ` : ""}${c.label} <small>${lib.counts[c.id]}</small></span>
    </label>`).join("");

  const kindOptions = Object.entries(KINDS).map(([value, label]) =>
    `<option value="${value}" ${last.libKind === value ? "selected" : ""}>${label}</option>`).join("");
  const impactOptions = `<option value="">Aucun</option>` + lib.impacts.map(path =>
    `<option value="${escape(path)}" ${last.libImpact === path ? "selected" : ""}>${escape(path.slice(5))}</option>`).join("");

  const targeted = new Set(Array.from(game.user.targets).map(t => t.id));
  const candidates = canvas.tokens.placeables
    .filter(t => t !== source && t.visible)
    .sort((a, b) => (targeted.has(b.id) - targeted.has(a.id)) || a.name.localeCompare(b.name));
  const targetRow = (t, label, cls = "") => `
      <label class="afx-target ${cls}">
        <input type="checkbox" name="target" value="${t.id}" ${targeted.has(t.id) ? "checked" : ""}>
        <img src="${escape(t.document.texture.src)}" alt="">
        <span>${label}</span>
      </label>`;
  const targetList = targetRow(source, `<b>Moi-même</b> (${escape(source.name)})`, "afx-self")
    + candidates.map(t => targetRow(t, escape(t.name))).join("");

  const durationRadios = Object.entries(DURATIONS).map(([value, label]) => `
    <label><input type="radio" name="duration" value="${value}" ${last.duration === value ? "checked" : ""}> ${label}${value === "long"
      ? ` <input type="number" name="durationSeconds" min="1" step="1" value="${Number(last.durationSeconds) || 30}"> s` : ""}</label>`).join("");

  const resultRadios = Object.entries(RESULTS).map(([value, label]) => `
    <label><input type="radio" name="result" value="${value}" ${last.result === value ? "checked" : ""}> ${label}</label>`).join("");

  const check = (name, label) =>
    `<label><input type="checkbox" name="${name}" ${last[name] ? "checked" : ""}> ${label}</label>`;
  const barsAvailable = !!globalThis.aerisBars;

  const content = `
    <div class="afx-dialog">
      <div class="afx-col">
        <p class="afx-source">Lanceur : <strong>${escape(source.name)}</strong></p>
        <nav class="afx-tabs">
          ${tab("recipes", "fa-book", "Recettes")}
          ${tab("library", "fa-swatchbook", `Bibliothèque JB2A <small>${lib.entries.length}</small>`)}
        </nav>
        <div class="afx-recipes">
          <select name="animation">${animationSelect}</select>
        </div>
        <div class="afx-library">
          <div class="afx-chips">${chips}</div>
          <input type="search" name="libSearch" value="${escape(last.libSearch)}" placeholder="Filtrer : fire, lightning, sword, blue…">
          <select name="libFile" size="12"></select>
          <p class="hint afx-lib-count"></p>
          <div class="form-group">
            <label>Type</label>
            <div class="form-fields"><select name="libKind">${kindOptions}</select></div>
          </div>
          <div class="form-group">
            <label>Impact</label>
            <div class="form-fields"><select name="libImpact">${impactOptions}</select></div>
          </div>
        </div>
        <video class="afx-preview" autoplay loop muted playsinline></video>
      </div>
      <div class="afx-col">
        <fieldset>
          <legend>Cibles</legend>
          <div class="afx-targets">${targetList}</div>
        </fieldset>
        <fieldset class="afx-results">
          <legend>Résultat</legend>
          ${resultRadios}
        </fieldset>
        <fieldset class="afx-duration">
          <legend>Durée</legend>
          ${durationRadios}
          <i class="fa-solid fa-circle-info afx-info" data-tooltip="S'applique aux effets joués sur le token : sorts sur la cible, auras, sur soi-même. Une animation permanente suit le token jusqu'à ce qu'on la retire dans « Effets permanents »."></i>
        </fieldset>
        <fieldset class="afx-options">
          <legend>Mise en scène</legend>
          ${check("camera", "Caméra")}
          ${check("darken", "Assombrir")}
          ${check("resultText", "Texte Critique / Raté")}
          ${barsAvailable ? check("bars", "Bandes cinéma (Aeris)") : ""}
        </fieldset>
        <details class="afx-active">
          <summary><i class="fa-solid fa-infinity"></i> Effets permanents <span class="afx-active-count"></span></summary>
          <div class="afx-active-list"></div>
        </details>
      </div>
    </div>`;

  const value = (root, name) => root.querySelector(`[name="${name}"]:is(:checked, select, input[type=search])`)?.value ?? "";
  const readLibrary = root => ({
    libCategory: value(root, "libCategory") || "all",
    libSearch: value(root, "libSearch"),
    libFile: value(root, "libFile"),
    libKind: value(root, "libKind"),
    libImpact: value(root, "libImpact")
  });

  const currentRecipe = root => value(root, "mode") === "library"
    ? libraryRecipe(readLibrary(root))
    : RECIPES.find(r => r.id === value(root, "animation"));

  /** Remplit la liste, groupée par famille JB2A ; renvoie l'entrée sélectionnée. */
  const fillLibrary = (root, selected) => {
    const { libCategory, libSearch } = readLibrary(root);
    const matches = searchLibrary(libCategory, libSearch);
    const shown = matches.slice(0, LIBRARY_LIMIT);
    const pinned = matches.find(e => e.path === selected);
    if (pinned && !shown.includes(pinned)) shown.unshift(pinned);
    if (!pinned) selected = shown[0]?.path;
    const html = Object.entries(Object.groupBy(shown, e => e.group)).map(([group, list]) => `
      <optgroup label="${escape(group.replaceAll("_", " "))}">
        ${list.map(e => `<option value="${escape(e.path)}" ${e.path === selected ? "selected" : ""}>${escape(e.label)}</option>`).join("")}
      </optgroup>`).join("");
    const select = root.querySelector("[name=libFile]");
    select.innerHTML = html;
    select.querySelector("option:checked")?.scrollIntoView({ block: "nearest" });
    root.querySelector(".afx-lib-count").textContent = matches.length > LIBRARY_LIMIT
      ? `${matches.length} animations : les ${LIBRARY_LIMIT} premières sont affichées, filtre pour affiner.`
      : `${matches.length} animation${matches.length > 1 ? "s" : ""} · double-clic pour lancer`;
    return select.value;
  };

  /** Liste des effets permanents de la scène, chacun avec son bouton de retrait. */
  const fillActive = (root, first = false) => {
    const list = manualEffects();
    const box = root.querySelector(".afx-active-list");
    box.innerHTML = list.length
      ? list.map(({ label, token }, i) => `
        <div class="afx-active-row">
          <span><b>${escape(token)}</b> · ${escape(label)}</span>
          <button type="button" data-afx-end="${i}" data-tooltip="Retirer"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join("") + (list.length > 1 ? `<button type="button" class="afx-end-all" data-afx-end="all"><i class="fa-solid fa-broom"></i> Tout retirer</button>` : "")
      : `<p class="hint">Aucun effet permanent sur la scène.</p>`;
    root.querySelector(".afx-active-count").textContent = list.length ? `(${list.length})` : "";
    if (first) root.querySelector(".afx-active").open = list.length > 0;   // déplié s'il y a des effets
    box.querySelectorAll("[data-afx-end]").forEach(btn => btn.addEventListener("click", async event => {
      event.preventDefault();
      const key = btn.dataset.afxEnd;
      const ids = (key === "all" ? list : [list[Number(key)]]).map(e => e.effect.id);
      await Sequencer.EffectManager.endEffects({ effects: ids });
      setTimeout(() => fillActive(root), 300);
    }));
  };

  /** Une aura passe d'office en « Permanente » (et revient en « Normale » en la quittant). */
  let previousKind;
  const syncDuration = (root, recipe) => {
    const kind = recipe?.kind;
    if (kind === previousKind) return;
    const pick = v => { const r = root.querySelector(`[name=duration][value="${v}"]`); if (r) r.checked = true; };
    if (kind === "aura") pick("persist");
    else if (previousKind === "aura" && value(root, "duration") === "persist") pick("normal");
    previousKind = kind;
  };

  const update = root => {
    const isLibrary = value(root, "mode") === "library";
    root.querySelector(".afx-recipes").hidden = isLibrary;
    root.querySelector(".afx-library").hidden = !isLibrary;
    const recipe = currentRecipe(root);
    syncDuration(root, recipe);
    const video = root.querySelector(".afx-preview");
    const file = recipe ? previewFile(recipe.file) : "";
    if (file) {
      if (video.getAttribute("src") !== file) video.src = file;
      video.hidden = false;
    }
    else video.hidden = true;
    root.querySelector(".afx-results").disabled = NO_RESULT.has(recipe?.kind);
  };

  const options = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Attaque FX", icon: "fa-solid fa-burst" },
    position: { width: 880 },
    classes: ["afx-window"],
    content,
    render: (event, dialog) => {
      const root = dialog?.element ?? event?.target?.element;
      if (!root) return;
      const on = (selector, type, fn) => root.querySelectorAll(selector).forEach(el =>
        el.addEventListener(type, () => { fn?.(); update(root); }));
      const refill = () => {
        const before = value(root, "libFile");
        const after = fillLibrary(root, before);
        if (after && after !== before) root.querySelector("[name=libKind]").value = suggestKind(after);
      };
      fillLibrary(root, last.libFile);
      previousKind = currentRecipe(root)?.kind;   // garder la durée enregistrée à l'ouverture
      update(root);
      fillActive(root, true);
      on("[name=mode]", "change");
      on("[name=animation]", "change");
      on("[name=libCategory]", "change", refill);
      on("[name=libSearch]", "input", refill);
      on("[name=libFile]", "change", () => {
        root.querySelector("[name=libKind]").value = suggestKind(value(root, "libFile"));
      });
      on("[name=libKind]", "change");
      root.querySelector("[name=libFile]").addEventListener("dblclick", event => {
        if (event.target.matches("option")) root.querySelector("[data-action=ok]")?.click();
      });
    },
    ok: {
      label: "PLAY",
      icon: "fa-solid fa-play",
      callback: (event, button) => {
        const form = button.form;
        const checked = name => !!form.querySelector(`[name="${name}"]`)?.checked;
        return {
          mode: value(form, "mode") || "recipes",
          animation: value(form, "animation"),
          ...readLibrary(form),
          targets: Array.from(form.querySelectorAll("[name=target]:checked"), el => el.value),
          result: value(form, "result") || "hit",
          camera: checked("camera"),
          darken: checked("darken"),
          resultText: checked("resultText"),
          bars: checked("bars"),
          duration: value(form, "duration") || "normal",
          durationSeconds: Number(form.querySelector("[name=durationSeconds]")?.value) || 30
        };
      }
    },
    rejectClose: false
  });
  if (!options) return;

  const { targets, ...remembered } = options;
  await game.settings.set(MODULE_ID, "last", remembered);
  if (!targets.length) return ui.notifications.warn("Attaque FX : aucune cible cochée.");
  const animation = options.mode === "library" ? libraryRecipe(options) : options.animation;
  return play({ ...options, animation, source });
}

/* -------------------------------------------- */
/*  États animés                                */
/* -------------------------------------------- */

/** Table état → animation : celle de recipes.js, corrigée par les réglages du monde. */
function statusTable() {
  const overrides = game.settings.get(MODULE_ID, "statusFx") ?? {};
  const table = {};
  for (const id of new Set([...Object.keys(STATUS_FX), ...Object.keys(overrides)])) {
    table[id] = { ...(STATUS_FX[id] ?? {}), ...(overrides[id] ?? {}) };
  }
  return table;
}

/** Un seul client (le MJ actif) crée et retire les effets, que tout le monde voit. */
const isLeadGM = () => game.users.activeGM?.isSelf ?? game.user.isGM;
const statusFxOn = () => game.settings.get(MODULE_ID, "statusFxEnabled");

/** Aligne les animations d'un token sur ses états : démarre celles qui manquent, arrête celles en trop. */
async function syncStatusFx(token) {
  if (!token?.document || !canvas.ready || !isLeadGM()) return;
  const table = statusTable();
  const active = statusFxOn() ? new Set(token.actor?.statuses ?? []) : new Set();
  const running = Sequencer.EffectManager.getEffects({ object: token, origin: MODULE_ID })
    .filter(e => e.data?.name?.startsWith(STATUS_PREFIX));
  const runningIds = new Set();
  const stale = [];
  for (const e of running) {
    const id = e.data.name.slice(STATUS_PREFIX.length);
    if (active.has(id) && table[id]?.file && !runningIds.has(id)) runningIds.add(id);
    else stale.push(e.id);
  }
  if (stale.length) await Sequencer.EffectManager.endEffects({ effects: stale });
  // Effets enregistrés sur le token mais pas encore affichés (scène en cours de chargement) : ne pas les doubler
  for (const entry of foundry.utils.getProperty(token.document, "flags.sequencer.effects") ?? []) {
    const name = (Array.isArray(entry) ? entry[1] : entry)?.name;
    if (name?.startsWith(STATUS_PREFIX)) runningIds.add(name.slice(STATUS_PREFIX.length));
  }
  for (const id of active) {
    const fx = table[id];
    if (!fx?.file || runningIds.has(id) || !Sequencer.Database.entryExists(fx.file)) continue;
    const seq = new Sequence(MODULE_ID);
    const effect = seq.effect()
      .file(fx.file)
      .attachTo(token, { bindVisibility: true })
      .scaleToObject(fx.scale ?? 1.3)
      .persist()
      .name(`${STATUS_PREFIX}${id}`)
      .origin(MODULE_ID)
      .fadeIn(500)
      .fadeOut(500);
    if (fx.below) effect.belowTokens();
    if (fx.offsetY) effect.spriteOffset({ x: 0, y: fx.offsetY }, { gridUnits: true });
    if (fx.opacity) effect.opacity(fx.opacity);
    await seq.play();
  }
}

/** Les tokens de la scène qui représentent un acteur (lié ou non). */
const tokensOf = actor => actor?.getActiveTokens?.() ?? [];
const syncAll = () => canvas.tokens?.placeables.forEach(t => syncStatusFx(t));

const pending = new Map();
/** Regroupe les changements rapprochés (plusieurs états posés d'un coup). */
function queueSync(token) {
  if (!token || !isLeadGM()) return;
  clearTimeout(pending.get(token.id));
  pending.set(token.id, setTimeout(() => { pending.delete(token.id); syncStatusFx(token); }, 150));
}

function onEffectChange(effect) {
  const actor = effect?.parent;
  if (actor instanceof Actor) tokensOf(actor).forEach(queueSync);
}

/** Fenêtre de réglage : une animation (et une taille) par état de base de Foundry. */
async function openStatusConfig() {
  const table = statusTable();
  const lib = getLibrary();
  const suggestions = lib.entries.filter(e => e.cats.has("token") || e.cats.has("elements") || e.cats.has("heal")).map(e => e.path);
  const statuses = CONFIG.statusEffects.filter(s => s.id);
  const rows = statuses.map(s => {
    const fx = table[s.id] ?? {};
    const name = game.i18n.localize(s.name ?? s.label ?? s.id);
    return `
      <tr>
        <td><img src="${escape(s.img ?? s.icon)}" alt="" class="afx-status-icon"> ${escape(name)}</td>
        <td><input type="text" name="file.${s.id}" value="${escape(fx.file ?? "")}" list="afx-status-files" placeholder="Aucune animation"></td>
        <td><input type="number" name="scale.${s.id}" value="${fx.scale ?? 1.3}" min="0.2" max="6" step="0.1"></td>
      </tr>`;
  }).join("");
  const content = `
    <div class="afx-status-config">
      <p class="hint">Quand un de ces états est posé sur un token, l'animation démarre, accrochée au token, et s'arrête quand l'état est retiré.
      Laisse vide pour ne rien jouer. Les noms viennent de la bibliothèque JB2A (onglet Bibliothèque de la fenêtre Attaque FX).</p>
      <datalist id="afx-status-files">${suggestions.map(p => `<option value="${escape(p)}">`).join("")}</datalist>
      <table>
        <thead><tr><th>État</th><th>Animation</th><th>Taille</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Attaque FX : états animés", icon: "fa-solid fa-person-burst" },
    position: { width: 720 },
    classes: ["afx-window"],
    content,
    buttons: [
      {
        action: "save", label: "Enregistrer", icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => Object.fromEntries(statuses.map(s => [s.id, {
          file: button.form.querySelector(`[name="file.${s.id}"]`).value.trim(),
          scale: Number(button.form.querySelector(`[name="scale.${s.id}"]`).value) || 1.3
        }]))
      },
      { action: "reset", label: "Valeurs d'origine", icon: "fa-solid fa-rotate-left", callback: () => "reset" },
      { action: "cancel", label: "Annuler", icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });
  if (!result || result === "cancel") return;
  let overrides = {};
  if (result !== "reset") {
    for (const [id, { file, scale }] of Object.entries(result)) {
      const base = STATUS_FX[id] ?? {};
      if (file === (base.file ?? "") && scale === (base.scale ?? 1.3)) continue;   // inchangé
      overrides[id] = file === base.file ? { scale } : { file, scale, below: false, offsetY: 0 };
    }
  }
  await game.settings.set(MODULE_ID, "statusFx", overrides);
  // Relancer les animations en cours avec les nouveaux réglages
  const all = Sequencer.EffectManager.getEffects({ origin: MODULE_ID }).filter(e => e.data?.name?.startsWith(STATUS_PREFIX));
  if (all.length) await Sequencer.EffectManager.endEffects({ effects: all.map(e => e.id) });
  syncAll();
  ui.notifications.info("Attaque FX : animations des états enregistrées.");
}

/** Bouton des réglages : Foundry attend une fenêtre ApplicationV2, celle-ci ouvre simplement la boîte de dialogue. */
class StatusFxMenu extends foundry.applications.api.ApplicationV2 {
  async render() {
    openStatusConfig();
    return this;
  }
}

/* -------------------------------------------- */
/*  Accès                                       */
/* -------------------------------------------- */

function canUse(token) {
  if (game.user.isGM) return true;
  return game.settings.get(MODULE_ID, "playerAccess") && token?.document?.isOwner;
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "playerAccess", {
    name: "Ouvrir aux joueurs",
    hint: "Les joueurs voient le bouton Attaque sur les tokens qu'ils possèdent. Vérifie aussi les permissions de Sequencer.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "last", {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
  game.settings.register(MODULE_ID, "statusFxEnabled", {
    name: "Animer les états",
    hint: "Poison, brûlure, saignement, étourdi… : quand un état est posé sur un token, une animation reste accrochée au token jusqu'à ce qu'il soit retiré.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => syncAll()
  });
  game.settings.register(MODULE_ID, "statusFx", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
  game.settings.registerMenu(MODULE_ID, "statusFxMenu", {
    name: "États animés",
    label: "Choisir les animations",
    hint: "L'animation (et sa taille) jouée pour chaque état de base de Foundry.",
    icon: "fa-solid fa-person-burst",
    type: StatusFxMenu,
    restricted: true
  });

  game.modules.get(MODULE_ID).api = {
    play, openDialog, openStatusConfig, syncStatusFx, recipes: RECIPES,
    library: () => getLibrary().entries.map(e => e.path)
  };
});

// États animés : le MJ actif suit les états posés / retirés et les tokens qui arrivent sur la scène.
Hooks.on("createActiveEffect", onEffectChange);
Hooks.on("updateActiveEffect", onEffectChange);
Hooks.on("deleteActiveEffect", onEffectChange);
Hooks.on("createToken", doc => setTimeout(() => queueSync(doc.object), 300));
Hooks.on("canvasReady", () => setTimeout(syncAll, 1500));

Hooks.on("renderTokenHUD", (hud, html) => {
  const token = hud.object;
  if (!canUse(token)) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const column = root?.querySelector(".col.left");
  if (!column) return;

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("control-icon", "afx-hud-button");
  button.dataset.tooltip = "Attaque FX";
  button.innerHTML = `<i class="fa-solid fa-burst"></i>`;
  button.addEventListener("click", event => {
    event.preventDefault();
    hud.close();
    openDialog(token);
  });
  column.append(button);
});
