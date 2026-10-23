// Better CSB Sheets : habillage de toutes les fiches Custom System Builder, des fenêtres de jet et du chat.
// Tout le CSS est derrière body.bcs-on : sans cette classe, rien ne s'applique.
// Character Sheet Meyiv (fiche-meyiv) habille déjà tout à sa façon : quand il est actif, ce module ne fait rien.

const ID = "better-csb-sheets";
const PALETTES = { parchemin: "Parchemin (vélin et bordeaux)", ardoise: "Ardoise (gris bleuté)", foret: "Forêt (cuir et vert sapin)" };

function applyLook() {
  const classes = document.body.classList;
  const theme = game.settings.get(ID, "theme");
  const palette = game.settings.get(ID, "palette");
  for (const t of ["auto", "light", "dark"]) classes.toggle(`bcs-${t}`, theme === t);
  for (const p of Object.keys(PALETTES)) classes.toggle(`bcs-pal-${p}`, palette === p);
}

Hooks.once("init", () => {
  if (game.modules.get("fiche-meyiv")?.active) {
    console.log(`${ID} | Character Sheet Meyiv est actif : Better CSB Sheets reste coupé.`);
    return;
  }
  game.settings.register(ID, "theme", {
    name: "Thème des fiches et du chat",
    hint: "« Suivre Foundry » reprend le thème clair ou sombre choisi dans les réglages de Foundry (général ou propre à chaque fenêtre).",
    scope: "client",
    config: true,
    type: String,
    choices: { auto: "Suivre Foundry", light: "Clair", dark: "Sombre" },
    default: "auto",
    onChange: applyLook
  });
  game.settings.register(ID, "palette", {
    name: "Palette de couleurs",
    hint: "Couleurs des fiches, des fenêtres de jet et du chat, pour toute la table. Chaque palette a sa version claire et sombre.",
    scope: "world",
    config: true,
    type: String,
    choices: PALETTES,
    default: "parchemin",
    onChange: applyLook
  });
  game.settings.register(ID, "accents", {
    name: "Couleur propre à chaque personnage",
    hint: "Le propriétaire d'un personnage peut remplacer la couleur d'accent de sa fiche (titres, onglet actif, cadre du portrait) par la couleur de son joueur ou une couleur choisie : menu ⋮ de la fiche, « Configurer la fiche », champ « Couleur d'accent ».",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: repaintAccents
  });
  document.body.classList.add("bcs-on");
  applyLook();
  setupDiceBar();
  setupCsbTooltip();
  setupAccents();
});

// ---------------------------------------------------------------- couleur du personnage
// Flag d'acteur `accent` = { mode: "player" } (couleur Foundry du joueur) ou { mode: "custom", color: "#rrggbb" }.
// Seuls l'accent et le liseré changent : fonds, textes et boutons restent ceux du mode clair ou nuit.
// La couleur est déclinée deux fois, assombrie pour le jour et éclaircie pour la nuit, jusqu'à rester lisible.

const hexToRgb = hex => { const n = parseInt(hex.slice(1, 7), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgbToHex = rgb => "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
const luminance = rgb => {
  const [r, g, b] = rgb.map(v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
};
function rgbToHsl([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => (v + m) * 255);
}
const shade = (hsl, dl) => hslToRgb([hsl[0], hsl[1], Math.min(1, Math.max(0, hsl[2] + dl))]);
// Monte (nuit) ou baisse (jour) la luminosité, teinte et saturation gardées, jusqu'au contraste voulu
// sur le fond le moins favorable du mode (mélanger du blanc ou du noir délavait les couleurs)
function readable(hsl, bg, step, target) {
  for (let dl = 0; Math.abs(dl) <= 1; dl += step) {
    const c = shade(hsl, dl);
    if (contrast(c, bg) >= target) return rgbToHsl(c);
  }
  return rgbToHsl(shade(hsl, step > 0 ? 1 : -1));
}
function accentVars(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  // Jour : texte posé au pire sur l'en-tête (#e3dac6) ; nuit : au pire sur une pastille (#2c2c31)
  const light = readable(hsl, hexToRgb("#e3dac6"), -.02, 5);
  const dark = readable(hsl, hexToRgb("#2c2c31"), .02, 5);
  return {
    "--bcs-l-accent": rgbToHex(shade(light, 0)),
    "--bcs-l-accent2": rgbToHex(shade(light, -.08)),
    "--bcs-l-gilt": rgbToHex(shade(light, .12)),
    "--bcs-d-accent": rgbToHex(shade(dark, 0)),
    "--bcs-d-accent2": rgbToHex(shade(dark, -.08)),
    "--bcs-d-gilt": rgbToHex(shade(dark, -.05))
  };
}

// Le joueur du personnage : celui dont c'est le personnage attitré, sinon le premier joueur propriétaire
function playerOf(actor) {
  const players = game.users.filter(u => !u.isGM);
  return players.find(u => u.character?.id === actor.id) ?? players.find(u => actor.testUserPermission(u, "OWNER")) ?? null;
}
const userHex = user => user ? (user.color?.css ?? String(user.color)) : null;

function accentOf(actor, flag = actor?.getFlag(ID, "accent")) {
  if (!actor || !game.settings.get(ID, "accents")) return null;
  if (flag?.mode === "player") return userHex(playerOf(actor));
  if (flag?.mode === "custom" && /^#[0-9a-f]{6}$/i.test(flag.color ?? "")) return flag.color;
  return null;
}
// Une fiche d'objet porté prend la couleur de son personnage
const actorOf = doc => doc?.documentName === "Actor" ? doc : doc?.parent?.documentName === "Actor" ? doc.parent : null;

const ACCENT_KEYS = Object.keys(accentVars("#000000"));
function paintAccent(element, hex) {
  element.classList.toggle("bcs-tinted", !!hex);
  const vars = hex ? accentVars(hex) : {};
  for (const key of ACCENT_KEYS) {
    if (hex) element.style.setProperty(key, vars[key]);
    else element.style.removeProperty(key);
  }
}
function paintSheet(app, element = app.element) {
  if (!element || !["Actor", "Item"].includes(app.document?.documentName)) return;
  paintAccent(element, accentOf(actorOf(app.document)));
}
function repaintAccents() {
  for (const app of foundry.applications.instances.values()) paintSheet(app);
}

// Le choix se fait dans la fenêtre « Configurer la fiche » de Foundry (ouverte aux propriétaires),
// sous le thème propre au document. Foundry ignore nos champs à l'enregistrement : on enregistre le flag nous-mêmes.
function addAccentField(app, form) {
  const actor = app.document;
  if (actor?.documentName !== "Actor" || !actor.isOwner || !game.settings.get(ID, "accents")) return;
  const fieldset = form.querySelector("fieldset");
  if (!fieldset || fieldset.querySelector(".bcs-accent-group")) return;
  const flag = actor.getFlag(ID, "accent") ?? {};
  const player = playerOf(actor);
  const playerHex = userHex(player);
  const esc = foundry.utils.escapeHTML;
  const option = (value, label, extra = "") => `<option value="${value}"${(flag.mode ?? "") === value ? " selected" : ""}${extra}>${label}</option>`;
  fieldset.insertAdjacentHTML("beforeend", `<div class="form-group bcs-accent-group">
      <label>Couleur d'accent</label>
      <div class="form-fields">
        <select name="bcsAccentMode">
          ${option("", "Couleurs de la palette")}
          ${option("player", playerHex ? `Couleur du joueur (${esc(player.name)})` : "Couleur du joueur (aucun joueur)", playerHex ? "" : " disabled")}
          ${option("custom", "Couleur choisie")}
        </select>
        <span class="bcs-accent-swatch"></span>
        <input type="color" name="bcsAccentColor" value="${flag.color ?? playerHex ?? "#3d7bd9"}">
      </div>
      <p class="hint">Couleur des titres et du cadre du portrait, visible par toute la table.</p>
    </div>`);
  const group = fieldset.querySelector(".bcs-accent-group");
  const select = group.querySelector("select"), picker = group.querySelector("input[type=color]");
  const swatch = group.querySelector(".bcs-accent-swatch");
  const read = () => select.value === "custom" ? { mode: "custom", color: picker.value } : select.value === "player" ? { mode: "player" } : null;
  // Aperçu en direct sur la fiche ouverte ; pastille de la couleur retenue (celle du joueur, ou rien pour la palette)
  const update = () => {
    const hex = accentOf(actor, read());
    picker.hidden = select.value !== "custom";
    swatch.hidden = select.value !== "player" || !hex;
    if (hex) swatch.style.background = hex;
    if (actor.sheet?.rendered) paintAccent(actor.sheet.element, hex);
  };
  select.addEventListener("change", update);
  picker.addEventListener("input", update);
  update();
  // La fenêtre (le <form>) survit aux nouveaux rendus : un seul écouteur
  if (form.dataset.bcsAccent) return;
  form.dataset.bcsAccent = "1";
  form.addEventListener("submit", () => {
    const value = form.querySelector(".bcs-accent-group") && read();
    form.dataset.bcsSaved = "1";
    const saved = value ? actor.setFlag(ID, "accent", value) : actor.getFlag(ID, "accent") ? actor.unsetFlag(ID, "accent") : null;
    Promise.resolve(saved).then(repaintAccents);
  });
}

function setupAccents() {
  Hooks.on("renderApplicationV2", (app, element) => paintSheet(app, element));
  Hooks.on("renderDocumentSheetConfig", (app, element) => addAccentField(app, element));
  // Fermée sans enregistrer : la fiche reprend sa couleur enregistrée
  Hooks.on("closeDocumentSheetConfig", app => { if (!app.element?.dataset.bcsSaved) repaintAccents(); });
  // Couleur ou personnage attitré d'un joueur, propriétaires ou flag d'un acteur : on repeint les fiches ouvertes
  Hooks.on("updateUser", repaintAccents);
  Hooks.on("updateActor", repaintAccents);
}

// ---------------------------------------------------------------- dés sous le total des jets de Foundry (/r, macros)
// Formule simple (des dés et des nombres) : bandeau « 4 + 6 + 2 » sous le total, le détail au clic est retiré (doublon).
// Formule complexe (parenthèses, groupes, fonctions) : pas de bandeau, le détail au clic reste.

function die(term, result) {
  const el = document.createElement("span");
  el.className = `bcs-de ${term.getResultCSS(result).filterJoin(" ")}`;
  el.innerHTML = term.getResultLabel(result);
  el.dataset.tooltip = `d${term.faces}`;
  return el;
}

function sign(text) {
  const el = document.createElement("span");
  el.className = "bcs-des-op";
  el.textContent = { "-": "−", "*": "×", "/": "÷" }[text] ?? text;
  return el;
}

// { simple, bar } : simple = la formule n'a que des dés, des nombres et des opérateurs ;
// bar = le bandeau, null si la formule est complexe ou se résume à un seul dé (le total le dit déjà).
function strip(roll) {
  const { DiceTerm, OperatorTerm, NumericTerm } = foundry.dice.terms;
  const parts = [];
  let dice = 0;
  for (const term of roll.terms) {
    if (term instanceof OperatorTerm) parts.push(sign(term.operator));
    else if (term instanceof NumericTerm) parts.push(sign(String(term.number)));
    else if (term instanceof DiceTerm) {
      // Les dés gardés, reliés par « + », puis les dés écartés ou relancés, grisés
      const kept = term.results.filter(r => r.active);
      kept.forEach((r, i) => {
        if (i) parts.push(sign("+"));
        parts.push(die(term, r));
      });
      for (const r of term.results.filter(r => !r.active)) parts.push(die(term, r));
      dice += term.results.length;
    }
    else return { simple: false, bar: null };
  }
  if (dice < 2 && parts.length < 2) return { simple: true, bar: null };
  const bar = document.createElement("div");
  bar.className = "bcs-des";
  bar.append(...parts);
  return { simple: true, bar };
}

function setupDiceBar() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    // Les jets de Foundry sont rendus dans l'ordre de message.rolls ; sinon (contenu sur mesure) on ne touche à rien
    const rollEls = root?.querySelectorAll(".message-content .dice-roll") ?? [];
    if (!rollEls.length || rollEls.length !== message.rolls.length) return;
    rollEls.forEach((el, i) => {
      // Jet privé ou aveugle vu par un joueur : Foundry n'envoie pas le détail, on ne le montre pas non plus
      if (!el.querySelector(".dice-tooltip") || el.querySelector(".bcs-des")) return;
      const { simple, bar } = strip(message.rolls[i]);
      if (bar) el.querySelector(".dice-total")?.after(bar);
      if (simple) {
        el.querySelector(".dice-tooltip").remove();
        el.removeAttribute("data-action");
      }
    });
  });
}

// ---------------------------------------------------------------- détail d'un jet de fiche CSB (fenêtre au clic)
// Au clic sur un résultat d'un message de fiche, CSB ouvre une fenêtre qui ne montre souvent que « roll = 49 » :
// beaucoup de templates calculent dans des variables cachées du message (#roll:=[1d100], #diff:=…) et n'affichent
// qu'un renvoi à ces variables. On remonte jusqu'à la variable d'origine, dans le même message, et on montre :
// sa formule, la valeur de chaque variable qu'elle utilise (avec ses dés), et les dés lancés.
// Tout vient des données que CSB range sur chaque résultat (data-roll-data) : rien de propre à un template.

const humanize = name => name ? name.replace(/^[nk]_/, "").replaceAll("_", " ") : "";
const pretty = expr => String(expr).trim().replace(/\s*\*\s*/g, " × ").replace(/\s*\/\s*/g, " ÷ ").replace(/\s+-\s+/g, " − ");
const shown = value => value === "" || value === null || value === undefined ? "—" : String(value).replace(/^-(?=\d)/, "−");

// Un résultat du message : « #nom:=formule » définit une variable (les saisies « #?{…} » n'en définissent pas)
function readPill(el) {
  let data;
  try { data = JSON.parse(el.dataset.rollData ?? ""); } catch { return null; }
  const m = String(data.raw ?? "").match(/^#\s*(\w+)\s*:=\s*([\s\S]*)$/);
  return { el, data, name: m?.[1] ?? null, expr: (m ? m[2] : String(data.raw ?? "").replace(/^#/, "")).trim() };
}

// Les variables utilisées par une formule, avec la valeur que CSB a calculée (arbre data.tokens)
function tokenValues(tokens, out = new Map()) {
  for (const t of tokens?.children ?? []) {
    if (t.handle && !out.has(t.handle)) out.set(t.handle, t.value);
    tokenValues(t, out);
  }
  return out;
}

// Les dés d'un jet de Foundry sérialisé (termes, y compris entre parenthèses)
function diceOf(roll, out = []) {
  for (const term of roll?.terms ?? []) {
    if (term.class === "Die" || term.faces) out.push(term);
    if (term.roll) diceOf(term.roll, out);
    for (const r of term.rolls ?? []) diceOf(r, out);
  }
  return out;
}

function diceChips(roll, negative) {
  const chips = document.createElement("span");
  chips.className = "bcs-dt-dice";
  for (const term of diceOf(roll)) {
    for (const r of term.results ?? []) {
      const cls = [`d${term.faces}`];
      // Dés d'un malus : un 6 n'est pas une bonne nouvelle, pas de vert ni de rouge
      if (!negative && r.result === term.faces) cls.push("max");
      if (!negative && r.result === 1) cls.push("min");
      if (r.active === false) cls.push("discarded");
      const chip = document.createElement("span");
      chip.className = `bcs-de ${cls.join(" ")}`;
      chip.textContent = r.result;
      chips.append(chip);
    }
  }
  return chips;
}

// Une ligne par jet de dés : nom de la clé ([:force:3d6] → « force ») ou « Dés », formule, dés, sous-total
function diceRows(rolls) {
  return (rolls ?? []).map(({ formula, roll }) => {
    const m = String(formula ?? "").match(/^\[!?(?::(\w+):)?([^\]]*)\]$/);
    const inner = (m ? m[2] : String(formula ?? "")).trim();
    const negative = /\*\s*-1/.test(roll?.formula ?? inner);
    const row = document.createElement("div");
    row.className = `bcs-dt-row${negative ? " bcs-dt-neg" : ""}`;
    row.innerHTML = `<span class="bcs-dt-name"></span><span class="bcs-dt-count"></span><span class="bcs-dt-value"></span>`;
    row.querySelector(".bcs-dt-name").textContent = humanize(m?.[1]) || "Dés";
    row.querySelector(".bcs-dt-count").textContent = pretty(roll?.formula ?? inner);
    row.querySelector(".bcs-dt-value").textContent = shown(roll?.total);
    row.querySelector(".bcs-dt-count").after(diceChips(roll, negative));
    return row;
  });
}

function explainCsbRoll(tooltip, pillEl) {
  const content = pillEl.closest(".message-content");
  const pills = [...content.querySelectorAll(".custom-system-roll[data-roll-data]")].map(readPill).filter(Boolean);
  let at = pills.findIndex(p => p.el === pillEl);
  if (at < 0) return false;
  // Dernière définition d'une variable avant une position (une variable peut être redéfinie dans le message)
  const defBefore = (name, index) => {
    for (let i = index - 1; i >= 0; i--) if (pills[i].name === name) return { def: pills[i], index: i };
    return null;
  };
  // Remonte les renvois (« roll », qui renvoie à « #roll:=[1d100] ») jusqu'à une vraie formule
  const follow = (start, index) => {
    let cur = { def: start, index };
    for (let hops = 0; hops < 6 && /^[A-Za-z_]\w*$/.test(cur.def.expr); hops++) {
      const found = defBefore(cur.def.expr, cur.index);
      if (!found) break;
      cur = found;
    }
    return cur;
  };
  const { def: target, index } = follow(pills[at], at);
  at = index;
  const { data } = target;
  const values = tokenValues(data.tokens);
  const rolls = data.rolls ?? [];
  // Rien à expliquer de plus que CSB (ni formule, ni variable, ni dé) : on garde sa fenêtre
  if (!values.size && !rolls.length && target.expr === String(data.result)) return false;

  const esc = foundry.utils.escapeHTML;
  const box = document.createElement("div");
  box.className = "bcs-dt";
  box.innerHTML = `<header class="bcs-dt-head">
      <span>${esc(humanize(target.name) || "Détail du jet")}</span>
      <span class="bcs-dt-total">${esc(shown(data.result))}</span>
    </header>`;
  // La formule, sauf si elle ne fait que lancer des dés (la ligne de dés le dit déjà)
  if (!/^\[[^\]]*\]$/.test(target.expr) && target.expr !== String(data.result)) {
    const f = document.createElement("div");
    f.className = "bcs-dt-formula";
    f.textContent = pretty(target.expr);
    box.append(f);
  }
  // Les variables utilisées, avec leur valeur ; une variable qui vient d'un jet montre aussi ses dés
  for (const [name, value] of values) {
    const row = document.createElement("div");
    row.className = "bcs-dt-row bcs-dt-var";
    row.innerHTML = `<span class="bcs-dt-name"></span><span class="bcs-dt-value"></span>`;
    row.querySelector(".bcs-dt-name").textContent = humanize(name);
    row.querySelector(".bcs-dt-value").textContent = shown(value);
    const found = defBefore(name, at);
    const source = found && follow(found.def, found.index);
    // Seulement pour une variable qui n'est qu'un jet ([1d100]) : dans « a ? [1d10] : b », le dé n'a peut-être pas compté
    const srcRolls = /^\[[^\]]*\]$/.test(source?.def.expr ?? "") ? source.def.data.rolls ?? [] : [];
    if (srcRolls.length) row.querySelector(".bcs-dt-name").after(...srcRolls.map(r => diceChips(r.roll, false)));
    box.append(row);
  }
  box.append(...diceRows(rolls));

  // L'arbre du calcul de CSB (quand il le donne) reste accessible, replié
  const tree = [...tooltip.querySelectorAll(".dice-rolls > li")].filter(li => li.querySelector(":scope > span"));
  if (tree.length) {
    const details = document.createElement("details");
    details.className = "bcs-dt-calc";
    details.innerHTML = "<summary>Calcul complet</summary><ol></ol>";
    details.querySelector("ol").append(...tree);
    // CSB ferme la fenêtre au premier clic dans la page : le clic sur « Calcul complet » ne doit pas la fermer
    details.addEventListener("click", event => event.stopPropagation());
    box.append(details);
  }
  tooltip.querySelector(".tooltip-part")?.replaceChildren(box);
  tooltip.classList.add("bcs-dt-tooltip");

  // CSB a placé la fenêtre d'après son ancienne taille : on la garde dans l'écran
  const rect = tooltip.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 3) tooltip.style.top = `${Math.max(3, window.innerHeight - rect.height - 3)}px`;
  else if (rect.top < 3) tooltip.style.top = "3px";
  if (rect.right > window.innerWidth - 3) tooltip.style.left = `${Math.max(3, window.innerWidth - rect.width - 3)}px`;
  return true;
}

function setupCsbTooltip() {
  // CSB ajoute sa fenêtre à la fin du message : on retient le résultat cliqué pour savoir quoi expliquer
  let clicked = null;
  document.addEventListener("click", event => {
    clicked = event.target.closest?.(".chat-message .custom-system-roll[data-roll-data]") ?? clicked;
  }, true);
  new MutationObserver(mutations => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (!node.classList?.contains("custom-inline-roll") || !node.closest(".chat-message")) continue;
        const tooltip = node.querySelector(".custom-roll-tooltip");
        if (!tooltip || clicked?.closest(".message-content") !== node.closest(".message-content")) continue;
        // En cas de souci, la fenêtre de CSB reste telle quelle
        try { explainCsbRoll(tooltip, clicked); }
        catch (err) { console.error(`${ID} | Détail du jet`, err); }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
