// Better Timer : minuteurs et chronomètres partagés.
// L'état de chaque minuteur est stocké dans un réglage du monde (écrit par le MJ uniquement) sous forme d'horodatages
// (heure du serveur) : chaque client calcule le temps restant lui-même, rien ne transite chaque seconde, et un
// rechargement de page (F5) ne coupe rien. Joueurs : affichage déplaçable (haut gauche). MJ : widget (bas gauche).

const ID = "better-timer";
const AUDIO = `modules/${ID}/audio`;
const DONE_KEEP_MS = 15000; // un minuteur terminé reste affiché 15 s, puis le MJ le retire

const PRESETS = [
  { label: "30 s", sec: 30 },
  { label: "1 min", sec: 60 },
  { label: "5 min", sec: 300 },
  { label: "10 min", sec: 600 },
  { label: "30 min", sec: 1800 },
  { label: "1 h", sec: 3600 }
];
const ADD_PRESETS = [1, 2, 5, 10]; // minutes proposées (en + et en −) par le menu « Ajouter / retirer du temps » du widget
const DEFAULT_FORM ={ kind: "down", duration: 300, ticks: "last10", endSound: true, visibility: "public", ignorePause: false };

/* ------------------------------------------------------------------ état */

const now = () => game.time.serverTime;
const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const readTimers = () => game.settings.get(ID, "timers") ?? {};
const isRunning = t => !t.paused && !t.pausedByGame && !t.finishedAt;
const elapsedOf = (t, at = now()) => t.elapsed + (t.startedAt != null ? Math.max(0, at - t.startedAt) : 0);
const isOver = (t, at = now()) => t.kind === "down" && (t.finishedAt || elapsedOf(t, at) >= t.duration);

// Après un changement de pause : met le temps écoulé en banque, ou repart de maintenant.
function sync(t, at = now()) {
  const run = isRunning(t);
  if (!run && t.startedAt != null) {
    t.elapsed = elapsedOf(t, at);
    t.startedAt = null;
  } else if (run && t.startedAt == null) t.startedAt = at;
  return t;
}

// Secondes affichées : restantes (arrondi au-dessus) pour un compte à rebours, écoulées pour un chronomètre.
function secondsOf(t) {
  const e = elapsedOf(t);
  return t.kind === "down" ? Math.max(0, Math.ceil((t.duration - e) / 1000)) : Math.floor(e / 1000);
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Durée lisible pour le chat : « 5 min », « 1 h 30 min », « 45 s ».
function formatSpan(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(" ") || "0 s";
}

const labelOf = t => t.label || (t.kind === "down" ? "Minuteur" : "Chronomètre");
const sees = t => game.user.isGM || t.visibility === "public";
const hears = t => game.user.isGM || t.visibility !== "gm";

// L'heure du serveur compte depuis le lancement du monde : elle repart de zéro quand le monde est relancé.
// Chaque minuteur garde l'heure réelle de ce lancement ; si elle a changé, on recale le minuteur
// (le temps réel écoulé pendant l'arrêt compte, comme une vraie minuterie).
const sessionStart = () => Date.now() - game.time.serverTime;
const needsRebase = t => t.session == null || Math.abs(t.session - sessionStart()) > 60000;
function rebase(t) {
  if (!needsRebase(t)) return false;
  const at = now();
  if (t.session != null) {
    if (t.startedAt != null) {
      t.elapsed += Math.max(0, Date.now() - (t.session + t.startedAt));
      t.startedAt = at;
    }
    if (t.finishedAt) t.finishedAt = at;
    t.createdAt = at - 1;
  }
  t.session = sessionStart();
  return true;
}

// Écritures du réglage à la file, pour qu'un clic et le ménage automatique ne s'écrasent pas.
// Si la fonction renvoie false (et qu'aucun minuteur n'a été recalé), rien n'est écrit.
let queue = Promise.resolve();
function mutate(fn) {
  queue = queue.then(async () => {
    const timers = foundry.utils.deepClone(readTimers());
    let rebased = false;
    for (const t of Object.values(timers)) rebased = rebase(t) || rebased;
    if (fn(timers) === false && !rebased) return;
    await game.settings.set(ID, "timers", timers);
  }).catch(err => console.error(`${ID} |`, err));
  return queue;
}

/* ------------------------------------------------------------------- chat */

// Annonce courte dans le chat (réglage « Messages dans le chat ») ; en message privé au MJ si les joueurs ne voient pas le minuteur.
function announce(t, icon, text) {
  if (!game.settings.get(ID, "chatMessages")) return;
  ChatMessage.create({
    speaker: { alias: "Minuteur" },
    content: `<div class="bt-chat"><i class="fa-solid fa-${icon}"></i><span>${text}</span></div>`,
    whisper: t.visibility === "public" ? [] : game.users.filter(u => u.isGM).map(u => u.id)
  });
}

const quoted = t => t.label ? ` « ${esc(t.label)} »` : "";

/* ------------------------------------------------------------------- API */

async function start({ kind = "down", label = "", duration = 0, ticks = "last10", endSound = true, visibility = "public", ignorePause = false } = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Seul le MJ peut lancer un minuteur.");
  kind = kind === "up" ? "up" : "down";
  const ms = Math.round(Number(duration) * 1000);
  if (kind === "down" && !(ms > 0)) return ui.notifications.warn("Indique une durée supérieure à 0.");
  const at = now();
  const t = {
    id: foundry.utils.randomID(),
    kind,
    label: String(label ?? "").trim().slice(0, 80),
    duration: kind === "down" ? ms : 0,
    elapsed: 0,
    startedAt: null,
    paused: false,
    pausedByGame: !ignorePause && game.paused,
    ticks: kind === "up" && ticks === "last10" ? "never" : ticks,
    endSound: !!endSound,
    visibility,
    ignorePause: !!ignorePause,
    finishedAt: null,
    createdAt: at,
    session: sessionStart()
  };
  sync(t, at);
  await mutate(timers => { timers[t.id] = t; });
  if (kind === "down") announce(t, "hourglass-start", `Minuteur${quoted(t)} lancé : <strong>${formatSpan(ms / 1000)}</strong>`);
  else announce(t, "stopwatch", `Chronomètre${quoted(t)} lancé`);
  return t.id;
}

function setPaused(id, paused) {
  return mutate(timers => {
    const t = timers[id];
    if (!t || t.finishedAt || t.paused === paused) return false;
    t.paused = paused;
    sync(t);
  });
}
const pause = id => setPaused(id, true);
const resume = id => setPaused(id, false);
const stop = id => mutate(timers => {
  if (!timers[id]) return false;
  delete timers[id];
});

// Ajoute (secondes > 0) ou retire (secondes < 0) du temps à un compte à rebours. Un minuteur terminé (encore affiché)
// repart avec le temps ajouté ; retirer plus que le temps restant le termine tout de suite (même en pause).
async function addTime(id, seconds) {
  const ms = Math.round(Number(seconds) * 1000);
  let changed = null;
  await mutate(timers => {
    const t = timers[id];
    if (!t || t.kind !== "down" || !ms || (ms < 0 && t.finishedAt)) return false;
    const at = now();
    t.duration = Math.max(1, t.duration + ms);
    if (t.finishedAt) {
      t.finishedAt = null;
      t.pausedByGame = !t.ignorePause && game.paused;
      sync(t, at);
    } else if (elapsedOf(t, at) >= t.duration) Object.assign(t, { elapsed: t.duration, startedAt: null, finishedAt: at });
    changed = { ...t };
  });
  if (!changed) return;
  const span = `${ms > 0 ? "+" : "−"}${formatSpan(Math.round(Math.abs(ms) / 1000))}`;
  announce(changed, "plus-minus", `<strong>${span}</strong> pour ${changed.label ? quoted(changed).trim() : "le minuteur"}`
    + (ms < 0 && changed.finishedAt ? " : temps écoulé" : ""));
}

/* ----------------------------------------------- tâches du MJ actif seul */

const isLeadGM = () => game.users.activeGM?.isSelf;

// Fige les minuteurs (sauf « continuer pendant la pause ») quand le jeu est en pause.
function syncGamePause(paused = game.paused) {
  if (!isLeadGM()) return;
  mutate(timers => {
    let changed = false;
    for (const t of Object.values(timers)) {
      if (t.ignorePause || t.finishedAt || t.pausedByGame === paused) continue;
      t.pausedByGame = paused;
      sync(t);
      changed = true;
    }
    return changed;
  });
}

// Marque les comptes à rebours arrivés à zéro, retire ceux terminés depuis plus de 15 s.
let housekeepingBusy = false;
function housekeeping() {
  if (housekeepingBusy || !isLeadGM()) return;
  const at = now();
  const due = t => (t.kind === "down" && !t.finishedAt && isRunning(t) && elapsedOf(t, at) >= t.duration)
    || (t.finishedAt && at - t.finishedAt > DONE_KEEP_MS);
  if (!Object.values(readTimers()).some(due)) return;
  housekeepingBusy = true;
  mutate(timers => {
    for (const t of Object.values(timers)) {
      if (!due(t)) continue;
      if (t.finishedAt) delete timers[t.id];
      else Object.assign(t, { elapsed: t.duration, startedAt: null, finishedAt: at });
    }
  }).finally(() => { housekeepingBusy = false; });
}

/* ------------------------------------------------------------------- sons */

function playSound(file, volume) {
  foundry.audio.AudioHelper.play({ src: `${AUDIO}/${file}`, volume, autoplay: true, loop: false, channel: "interface" }, false);
}

// Dernière seconde vue pour chaque minuteur : un son ne part que sur un vrai changement de seconde
// (rien au chargement de la page, rien de rejoué après un F5).
const lastSeen = new Map();
function sounds(timers) {
  for (const t of timers) {
    const sec = secondsOf(t);
    const prev = lastSeen.get(t.id);
    lastSeen.set(t.id, sec);
    if (prev === undefined || prev === sec || !hears(t)) continue;
    if (t.kind === "down" && sec < prev) {
      if (sec === 0) {
        if (t.endSound) playSound("end.wav", 0.7);
        if (sees(t)) ui.notifications.info(t.label ? `Temps écoulé : ${t.label}` : "Temps écoulé !");
      } else if (t.ticks === "always" || (t.ticks === "last10" && sec <= 10)) playSound(`tick${(sec % 2) + 1}.wav`, 0.8);
    } else if (t.kind === "up" && sec > prev && t.ticks === "always") playSound(`tick${(sec % 2) + 1}.wav`, 0.8);
  }
}

/* -------------------------------------------------------------- affichage */

function ensureRoot(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("section");
    el.id = id;
    el.className = "bt-ui";
    el.hidden = true;
    document.body.append(el);
  }
  return el;
}

const sortedTimers = () => Object.values(readTimers()).sort((a, b) => a.createdAt - b.createdAt);

function visibilityIcon(t) {
  if (t.visibility === "gm") return `<i class="fa-solid fa-eye-slash" data-tooltip="MJ seulement"></i>`;
  if (t.visibility === "sound") return `<i class="fa-solid fa-volume-high" data-tooltip="Les joueurs entendent le son sans voir le temps"></i>`;
  return "";
}

function cardHTML(t) {
  return `<div class="bt-card" data-id="${t.id}">
    <div class="bt-label">${esc(labelOf(t))}</div>
    <div class="bt-time"></div>
    <div class="bt-state"></div>
    ${t.kind === "down" ? `<div class="bt-bar"><span></span></div>` : ""}
  </div>`;
}

function rowHTML(t) {
  return `<div class="bt-row" data-id="${t.id}">
    <div class="bt-row-info">
      <span class="bt-label">${esc(labelOf(t))} ${visibilityIcon(t)}</span>
      <span class="bt-state"></span>
    </div>
    <span class="bt-time"></span>
    ${t.kind === "down" ? `<button type="button" data-bt="add" data-tooltip="Ajouter / retirer du temps"><i class="fa-solid fa-plus-minus"></i></button>` : ""}
    <button type="button" data-bt="toggle"><i class="fa-solid fa-pause"></i></button>
    <button type="button" data-bt="stop" data-tooltip="Arrêter"><i class="fa-solid fa-stop"></i></button>
    ${t.kind === "down" ? `<div class="bt-bar"><span></span></div>` : ""}
  </div>`;
}

// Reconstruit l'affichage (joueurs) ou le widget (MJ) quand la liste des minuteurs change.
function render() {
  const timers = sortedTimers();
  for (const id of lastSeen.keys()) if (!timers.some(t => t.id === id)) lastSeen.delete(id);
  if (!timers.some(t => t.id === document.getElementById("bt-addmenu")?.dataset.timer)) closeAddMenu();
  if (game.user.isGM) {
    const root = ensureRoot("bt-widget");
    root.hidden = !timers.length;
    root.innerHTML = `<header class="bt-widget-head" data-drag>
        <i class="fa-solid fa-hourglass-half"></i><span>Minuteurs</span>
        <button type="button" data-bt="new" data-tooltip="Nouveau minuteur"><i class="fa-solid fa-plus"></i></button>
      </header>${timers.map(rowHTML).join("")}`;
    restorePosition(root, "widgetPos");
  } else {
    const list = timers.filter(sees);
    const root = ensureRoot("bt-display");
    root.hidden = !list.length;
    root.innerHTML = list.map(cardHTML).join("");
    restorePosition(root, "displayPos");
  }
  update();
}

// Met à jour les chiffres, couleurs et boutons (plusieurs fois par seconde, sans reconstruire).
function update() {
  const timers = readTimers();
  for (const el of document.querySelectorAll(".bt-ui [data-id]")) {
    const t = timers[el.dataset.id];
    if (!t) continue;
    const sec = secondsOf(t);
    const over = isOver(t);
    const paused = !over && !isRunning(t);
    el.querySelector(".bt-time").textContent = formatTime(sec);
    el.classList.toggle("is-done", !!over);
    el.classList.toggle("is-paused", paused);
    el.classList.toggle("is-warn", t.kind === "down" && !over && sec <= 10 && sec > 5);
    el.classList.toggle("is-danger", t.kind === "down" && !over && sec <= 5);
    el.querySelector(".bt-state").textContent = over ? "Temps écoulé !"
      : t.paused ? "En pause"
      : t.pausedByGame ? "Jeu en pause" : "";
    const bar = el.querySelector(".bt-bar span");
    if (bar) bar.style.width = `${clamp(1 - elapsedOf(t) / t.duration, 0, 1) * 100}%`;
    const toggle = el.querySelector('[data-bt="toggle"]');
    if (toggle) {
      toggle.disabled = !!over;
      toggle.dataset.tooltip = t.paused ? "Reprendre" : "Pause";
      toggle.firstElementChild.className = `fa-solid fa-${t.paused ? "play" : "pause"}`;
    }
  }
}

/* ------------------------------------------------------------ déplacement */

function place(el, left, top) {
  const { width, height } = el.getBoundingClientRect();
  Object.assign(el.style, {
    left: `${clamp(left, 0, window.innerWidth - width)}px`,
    top: `${clamp(top, 0, window.innerHeight - height)}px`,
    right: "auto",
    bottom: "auto"
  });
}

// Position mémorisée par joueur ; sans position, le CSS place l'élément (haut gauche / bas gauche).
function restorePosition(el, key) {
  const pos = game.settings.get(ID, key);
  if (el.hidden || pos?.left == null) return;
  place(el, pos.left, pos.top);
}

function makeDraggable(el, key, handleOnly) {
  el.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    if (handleOnly && !event.target.closest("[data-drag]")) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    el.setPointerCapture(event.pointerId);
    el.classList.add("is-dragging");
    const move = e => place(el, e.clientX - dx, e.clientY - dy);
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.classList.remove("is-dragging");
      game.settings.set(ID, key, { left: parseFloat(el.style.left), top: parseFloat(el.style.top) });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  });
}

/* ---------------------------------- menu « Ajouter / retirer du temps » (MJ) */

// Petit menu flottant posé au-dessus du bouton (en dessous s'il n'y a pas la place) : une ligne d'ajouts,
// une ligne de retraits. Hors du widget, qui coupe ce qui dépasse et se reconstruit à chaque changement des minuteurs.
function openAddMenu(button, id) {
  const menu = ensureRoot("bt-addmenu");
  if (!menu.hidden && menu.dataset.timer === id) return closeAddMenu();
  menu.dataset.timer = id;
  menu.innerHTML = ADD_PRESETS.map(min => `<button type="button" data-min="${min}">+${min} min</button>`).join("")
    + ADD_PRESETS.map(min => `<button type="button" data-min="-${min}" class="bt-minus">−${min} min</button>`).join("");
  menu.hidden = false;
  const b = button.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  place(menu, b.right - width, b.top - height - 6 >= 0 ? b.top - height - 6 : b.bottom + 6);
}

function closeAddMenu() {
  const menu = document.getElementById("bt-addmenu");
  if (!menu) return;
  menu.hidden = true;
  delete menu.dataset.timer;
}

/* ---------------------------------------------------- fenêtre de lancement */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class TimerLauncher extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "better-timer-launcher",
    tag: "form",
    classes: ["better-timer"],
    window: { title: "Nouveau minuteur", icon: "fa-solid fa-hourglass-half" },
    position: { width: 420 },
    form: { handler: TimerLauncher.#onSubmit, closeOnSubmit: true },
    actions: { preset: TimerLauncher.#onPreset }
  };

  static PARTS = { form: { template: `modules/${ID}/templates/lanceur.hbs` } };

  async _prepareContext() {
    const f = { ...DEFAULT_FORM, ...game.settings.get(ID, "lastForm") };
    return {
      f,
      h: Math.floor(f.duration / 3600),
      m: Math.floor((f.duration % 3600) / 60),
      s: f.duration % 60,
      presets: PRESETS,
      kinds: { down: "Compte à rebours", up: "Chronomètre" },
      tickChoices: { always: "Toutes les secondes", last10: "10 dernières secondes", never: "Jamais" },
      visibilityChoices: { public: "Tout le monde", sound: "Joueurs : son seulement", gm: "MJ seulement" }
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const kind = this.element.querySelector('[name="kind"]');
    const ticks = this.element.querySelector('[name="ticks"]');
    const apply = () => {
      const up = kind.value === "up";
      this.element.classList.toggle("is-chrono", up);
      if (up && ticks.value === "last10") ticks.value = "never";
    };
    kind.addEventListener("change", apply);
    apply();
  }

  static #onPreset(event, target) {
    const sec = Number(target.dataset.sec);
    const set = (name, v) => { this.element.querySelector(`[name="${name}"]`).value = v; };
    set("h", Math.floor(sec / 3600));
    set("m", Math.floor((sec % 3600) / 60));
    set("s", sec % 60);
  }

  static async #onSubmit(event, form, formData) {
    const d = formData.object;
    const num = v => Math.max(0, Math.floor(Number(v) || 0));
    const duration = num(d.h) * 3600 + num(d.m) * 60 + num(d.s);
    const kind = d.kind === "up" ? "up" : "down";
    const options = { kind, duration, ticks: d.ticks, endSound: !!d.endSound, visibility: d.visibility, ignorePause: !!d.ignorePause };
    if (kind === "down" && duration <= 0) throw new Error("Indique une durée supérieure à 0.");
    await game.settings.set(ID, "lastForm", { ...options, duration: kind === "down" ? duration : game.settings.get(ID, "lastForm")?.duration ?? DEFAULT_FORM.duration });
    await start({ ...options, label: d.label });
  }
}

function openLauncher() {
  const existing = foundry.applications.instances.get("better-timer-launcher");
  if (existing) existing.bringToFront();
  else new TimerLauncher().render({ force: true });
}

/* ------------------------------------------------------------------ hooks */

Hooks.once("init", () => {
  game.settings.register(ID, "timers", { scope: "world", config: false, type: Object, default: {}, onChange: () => render() });
  game.settings.register(ID, "chatMessages", {
    name: "Messages dans le chat",
    hint: "Annonce le lancement d'un minuteur et le temps ajouté ou retiré (en message privé au MJ si les joueurs ne voient pas le minuteur).",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(ID, "lastForm", { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(ID, "displayPos", { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(ID, "widgetPos", { scope: "client", config: false, type: Object, default: {} });
});

Hooks.on("getSceneControlButtons", controls => {
  const notes = controls.notes;
  if (!notes) return;
  notes.tools[ID] = {
    name: ID,
    title: "Better Timer",
    icon: "fa-solid fa-hourglass-half",
    order: Object.keys(notes.tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => openLauncher()
  };
});

Hooks.on("pauseGame", paused => syncGamePause(paused));

Hooks.once("ready", () => {
  game.modules.get(ID).api = { start, pause, resume, stop, addTime, open: openLauncher };
  foundry.audio.AudioHelper.preloadSound(`${AUDIO}/end.wav`);

  const display = ensureRoot("bt-display");
  const widget = ensureRoot("bt-widget");
  makeDraggable(display, "displayPos", false);
  makeDraggable(widget, "widgetPos", true);
  widget.addEventListener("click", event => {
    const button = event.target.closest("[data-bt]");
    if (!button) return;
    const id = button.closest("[data-id]")?.dataset.id;
    if (button.dataset.bt === "new") openLauncher();
    else if (button.dataset.bt === "add") openAddMenu(button, id);
    else if (button.dataset.bt === "stop") stop(id);
    else if (button.dataset.bt === "toggle") readTimers()[id]?.paused ? resume(id) : pause(id);
  });
  const addMenu = ensureRoot("bt-addmenu");
  addMenu.addEventListener("click", event => {
    const min = Number(event.target.closest("[data-min]")?.dataset.min);
    if (!min) return;
    addTime(addMenu.dataset.timer, min * 60);
    closeAddMenu();
  });
  // Un clic ailleurs (y compris pour déplacer le widget) ou Échap ferme le menu.
  document.addEventListener("pointerdown", event => {
    if (!addMenu.hidden && !addMenu.contains(event.target) && !event.target.closest('[data-bt="add"]')) closeAddMenu();
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeAddMenu();
  });
  window.addEventListener("resize", () => {
    closeAddMenu();
    restorePosition(display, "displayPos");
    restorePosition(widget, "widgetPos");
  });

  render();
  if (isLeadGM() && Object.values(readTimers()).some(needsRebase)) mutate(() => false);
  syncGamePause();
  setInterval(() => {
    housekeeping();
    sounds(Object.values(readTimers()));
    update();
  }, 200);
});
