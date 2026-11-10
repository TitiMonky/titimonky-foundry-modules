// Better Timer : minuteur de tour.
// Le MJ l'active dans l'onglet Combat, avec une durée (1 / 2 / 3 / 5 min, puis à la minute). Il ne tourne que pendant
// le tour d'un personnage de joueur et repart au maximum à chaque changement de tour. Tout le monde
// voit le bandeau (en bas au centre, déplaçable) ; à zéro, le MJ a un bouton « Passer le tour » (rien d'automatique).
// Début de chaque tour : caméra centrée et zoomée sur le jeton chez tout le monde (joueurs compris),
// bandes noires, halo sombre autour, et animation « NEXT TURN » au-dessus du jeton.
//
// Même principe que les minuteurs : état sous forme d'horodatages (heure du serveur), ici dans un drapeau du combat
// (`flags.better-timer.turn`), écrit par un MJ seulement ; chaque client calcule le temps lui-même.
//
// Ce fichier est importé par better-timer.js et importe ses fonctions en retour (import circulaire) : rien de
// better-timer.js ne doit être utilisé au premier niveau de ce fichier, seulement dans les fonctions.

import {
  now, clamp, esc, isRunning, elapsedOf, sync, formatTime, sessionStart, needsRebase, rebase,
  playSound, ensureRoot, place, makeDraggable, openAddMenu, closeAddMenu, isLeadGM
} from "./better-timer.js";

const MOD = "better-timer";
const MEDIA = `modules/${MOD}/media`;
const TURN_PRESETS = [1, 2, 3, 5];          // minutes proposées dans l'onglet Combat
const TURN_MIN = 60, TURN_MAX = 30 * 60;    // bornes de la durée (secondes)
const WARN_SEC = 30, DANGER_SEC = 10;       // orange sous 30 s, rouge sous 10 s
const FOCUS_SCALE = 1;                      // zoom minimal de la caméra sur le jeton (on ne dézoome jamais)
const PAN_MS = 800, HOLD_MS = 2900, FX_MS = 3900; // 3,9 s = durée de l'animation NEXT TURN
const ANIM_RATIO = 270 / 640;               // hauteur / largeur de next-turn.webm
const AUTO_SKIP_MS = 3000;                  // passage automatique : 3 s après zéro (son de fin, « Temps écoulé ! »)

// Safari (et les navigateurs d'iPhone / iPad) ne gère pas la transparence des WebM : WebP animé à la place.
const WEBM_ALPHA = !(/AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent));

/* ------------------------------------------------------------------- état */

const lastDuration = () => clamp(Number(game.settings.get(MOD, "turnDuration")) || 120, TURN_MIN, TURN_MAX) * 1000;

function readTurn(combat) {
  const f = combat?.getFlag(MOD, "turn") ?? {};
  return { enabled: !!f.enabled, duration: f.duration ?? lastDuration(), autoSkip: !!f.autoSkip, timer: f.timer ?? null };
}

// Clé du tour en cours : un nouveau round ou un autre combattant = un nouveau tour (le minuteur repart au maximum).
// Pas l'index du tour : un jet d'initiative qui réordonne la liste ne relance pas le minuteur du combattant actif.
const keyOf = combat => (combat?.started && combat.combatant) ? `${combat.round}:${combat.combatant.id}` : null;

// Tour chronométré : minuteur activé et combattant qui appartient à un joueur (les PNJ n'ont pas de minuteur).
const isTimed = (combat, s = readTurn(combat)) => !!(s.enabled && keyOf(combat) && combat.combatant.hasPlayerOwner);

function freshTimer(combat, s) {
  return sync({
    kind: "down", key: keyOf(combat), duration: s.duration, elapsed: 0, startedAt: null, paused: false,
    pausedByGame: game.paused, ignorePause: false, finishedAt: null, createdAt: now(), session: sessionStart()
  });
}

// Minuteur du tour en cours. Le temps que le MJ l'écrive (une fraction de seconde après le changement de tour),
// on affiche un minuteur plein à l'arrêt plutôt que celui du tour précédent.
function currentTimer(combat) {
  const s = readTurn(combat);
  if (!isTimed(combat, s)) return null;
  if (s.timer?.key === keyOf(combat)) return s.timer;
  return { kind: "down", key: keyOf(combat), duration: s.duration, elapsed: 0, startedAt: null, paused: false,
    pausedByGame: false, finishedAt: null, pending: true };
}

const isOver = t => !!t.finishedAt || elapsedOf(t) >= t.duration;
const secondsLeft = t => Math.max(0, Math.ceil((t.duration - elapsedOf(t)) / 1000));

// Change la durée du tour en cours en gardant le temps écoulé. Un tour arrivé à zéro repart s'il reste du temps ;
// une durée plus courte que le temps écoulé termine le tour tout de suite.
function applyDuration(t, ms) {
  const at = now();
  t.duration = Math.max(1000, Math.round(ms));
  if (t.finishedAt) {
    if (t.elapsed < t.duration) {
      t.finishedAt = null;
      t.pausedByGame = game.paused;
      sync(t, at);
    }
  } else if (elapsedOf(t, at) >= t.duration) Object.assign(t, { elapsed: t.duration, startedAt: null, finishedAt: at });
}

// Écritures du drapeau à la file (un clic du MJ et une tâche automatique ne s'écrasent pas).
// Si la fonction renvoie false (et que rien n'a été recalé après une relance du monde), rien n'est écrit.
let queue = Promise.resolve();
function writeTurn(combat, fn) {
  if (!game.user.isGM || !combat) return queue;
  queue = queue.then(async () => {
    if (!game.combats.has(combat.id)) return;
    const s = foundry.utils.deepClone(readTurn(combat));
    const rebased = s.timer ? rebase(s.timer) : false;
    if (fn(s) === false && !rebased) return;
    await combat.setFlag(MOD, "turn", s);
  }).catch(err => console.error(`${MOD} |`, err));
  return queue;
}

/* -------------------------------------------------------- actions du MJ */

function setEnabled(combat, enabled) {
  return writeTurn(combat, s => {
    s.enabled = !!enabled;
    s.timer = isTimed(combat, s) ? freshTimer(combat, s) : null;
  });
}

// Passage automatique au tour suivant quand le temps est écoulé (facultatif, par combat).
function setAutoSkip(combat, autoSkip) {
  return writeTurn(combat, s => {
    if (s.autoSkip === !!autoSkip) return false;
    s.autoSkip = !!autoSkip;
  });
}

// Durée choisie (secondes) : vaut pour les tours suivants et pour le tour en cours ; mémorisée pour les prochains combats.
function setDuration(combat, seconds) {
  const sec = clamp(Math.round(Number(seconds) || 0), TURN_MIN, TURN_MAX);
  game.settings.set(MOD, "turnDuration", sec);
  return writeTurn(combat, s => {
    if (s.duration === sec * 1000) return false;
    s.duration = sec * 1000;
    if (s.timer) applyDuration(s.timer, s.duration);
  });
}

// Ajoute (secondes > 0) ou retire (secondes < 0) du temps au tour en cours seulement (menu ± du bandeau).
function addTurnTime(combatId, seconds) {
  const combat = game.combats.get(combatId);
  const ms = Math.round(Number(seconds) * 1000);
  return writeTurn(combat, s => {
    const t = s.timer;
    if (!t || t.key !== keyOf(combat) || !ms || (ms < 0 && t.finishedAt)) return false;
    applyDuration(t, t.duration + ms);
  });
}

function setPaused(combat, paused) {
  return writeTurn(combat, s => {
    const t = s.timer;
    if (!t || t.finishedAt || t.paused === paused) return false;
    t.paused = paused;
    sync(t);
  });
}

/* ------------------------------------------------- tâches du MJ actif seul */

// Un minuteur neuf à chaque nouveau tour chronométré, aucun pendant les tours des PNJ.
const ensuring = new Set();
function ensureTurn(combat) {
  if (!combat || !isLeadGM() || ensuring.has(combat.id)) return;
  const s = readTurn(combat);
  const timed = isTimed(combat, s);
  if (timed ? s.timer?.key === keyOf(combat) : !s.timer) return;
  ensuring.add(combat.id);
  writeTurn(combat, st => {
    if (isTimed(combat, st)) {
      if (st.timer?.key === keyOf(combat)) return false;
      st.timer = freshTimer(combat, st);
    } else {
      if (!st.timer) return false;
      st.timer = null;
    }
  }).finally(() => ensuring.delete(combat.id));
}

// Marque le tour arrivé à zéro (le temps s'arrête là : un ajout de temps repart de zéro, pas de « temps négatif »).
let finishing = false;
function finishDue() {
  if (finishing || !isLeadGM()) return;
  const combat = game.combats.find(c => {
    const t = c.getFlag(MOD, "turn")?.timer;
    return t && !t.finishedAt && isRunning(t) && elapsedOf(t) >= t.duration;
  });
  if (!combat) return;
  finishing = true;
  writeTurn(combat, s => {
    const t = s.timer;
    if (!t || t.finishedAt || elapsedOf(t) < t.duration) return false;
    Object.assign(t, { elapsed: t.duration, startedAt: null, finishedAt: now() });
  }).finally(() => { finishing = false; });
}

// Passage automatique : 3 s après zéro, si l'option est cochée pour ce combat. La pause du jeu le retient (il part à
// la reprise) ; « +1 min » pendant ces 3 s l'annule (le tour repart, et repassera à son nouveau zéro).
const autoSkipped = new Set();
function autoSkipDue() {
  if (!isLeadGM() || game.paused) return;
  for (const combat of game.combats) {
    const s = readTurn(combat);
    const t = s.timer;
    if (!s.autoSkip || !t?.finishedAt || t.key !== keyOf(combat) || now() - t.finishedAt < AUTO_SKIP_MS) continue;
    const once = `${combat.id}:${t.key}:${t.finishedAt}`;
    if (autoSkipped.has(once)) continue;
    autoSkipped.add(once);
    combat.nextTurn().catch(err => console.error(`${MOD} |`, err));
  }
}

// La pause du jeu fige le minuteur de tour.
function syncGamePause(paused = game.paused) {
  if (!isLeadGM()) return;
  for (const combat of game.combats) {
    const t = combat.getFlag(MOD, "turn")?.timer;
    if (!t || t.finishedAt || t.pausedByGame === paused) continue;
    writeTurn(combat, s => {
      if (!s.timer || s.timer.finishedAt || s.timer.pausedByGame === paused) return false;
      s.timer.pausedByGame = paused;
      sync(s.timer);
    });
  }
}

/* ---------------------------------------------------------------- bandeau */

// « Tour d'Elise », « Tour de Brakk ».
const turnOf = name => `Tour ${/^[aeiouyhàâäéèêëîïôöùûü]/i.test(name) ? "d'" : "de "}${name}`;

// Prochain combattant que ce client a le droit de voir (les PNJ cachés sont sautés chez les joueurs).
function nextName(combat) {
  const turns = combat.turns ?? [];
  const skipDefeated = combat.settings?.skipDefeated;
  for (let i = 1; i < turns.length; i++) {
    const c = turns[(combat.turn + i) % turns.length];
    if (skipDefeated && c.isDefeated) continue;
    if (!game.user.isGM && !c.visible) continue;
    return c.name;
  }
  return "";
}

function bannerHTML(combat, c) {
  const next = nextName(combat);
  const gm = game.user.isGM;
  const own = !gm && c.isOwner;
  const img = c.img || c.token?.texture?.src || "icons/svg/mystery-man.svg";
  return `<div class="bt-turn-card">
    <img class="bt-turn-img" src="${esc(img)}" alt="">
    <div class="bt-turn-main">
      <div class="bt-turn-top"><span class="bt-label">${esc(turnOf(c.name))}</span><span class="bt-time"></span></div>
      <div class="bt-bar"><span></span></div>
      <div class="bt-turn-foot"><span class="bt-turn-next">${next ? `Ensuite : ${esc(next)}` : ""}</span><span class="bt-state"></span></div>
    </div>
    ${gm ? `<div class="bt-turn-actions">
      <div class="bt-turn-tools">
        <button type="button" data-bt="add" data-tooltip="Ajouter / retirer du temps"><i class="fa-solid fa-plus-minus"></i></button>
        <button type="button" data-bt="toggle"><i class="fa-solid fa-pause"></i></button>
      </div>
      <button type="button" class="bt-turn-skip" data-bt="skip"><i class="fa-solid fa-forward-step"></i> Passer le tour</button>
    </div>` : ""}
    ${own ? `<div class="bt-turn-actions"><button type="button" class="bt-turn-end" data-bt="end" data-tooltip="Finir mon tour"><i class="fa-solid fa-check"></i></button></div>` : ""}
  </div>`;
}

// Position mémorisée par joueur ; sinon en bas au centre, au-dessus de la barre de macros (zone libre de Better Theater).
function positionBanner(root) {
  const pos = game.settings.get(MOD, "turnPos");
  if (pos?.left != null) return place(root, pos.left, pos.top);
  const { width, height } = root.getBoundingClientRect();
  const hotbar = document.getElementById("hotbar")?.getBoundingClientRect();
  const top = hotbar?.height ? hotbar.top - height - 12 : window.innerHeight - height - 110;
  place(root, (window.innerWidth - width) / 2, top);
}

function renderBanner() {
  const combat = game.combat;
  const t = currentTimer(combat);
  const c = combat?.combatant;
  const root = ensureRoot("bt-turn");
  const show = !!t && (game.user.isGM || c.visible);
  const menu = document.getElementById("bt-addmenu");
  if (!show) {
    root.hidden = true;
    root.innerHTML = "";
    delete root.dataset.combat;
    if (menu?.dataset.timer?.startsWith("turn:")) closeAddMenu();
    return;
  }
  if (menu?.dataset.timer?.startsWith("turn:") && menu.dataset.timer !== `turn:${combat.id}`) closeAddMenu();
  root.dataset.combat = combat.id;
  root.innerHTML = bannerHTML(combat, c);
  root.hidden = false;
  positionBanner(root);
  updateBanner();
}

// Dernière seconde vue par tour : un son ne part que sur un vrai changement de seconde (rien après un F5).
const lastSeen = { key: null, sec: null };
function sounds(t) {
  const sec = secondsLeft(t);
  const prev = lastSeen.key === t.key ? lastSeen.sec : null;
  Object.assign(lastSeen, { key: t.key, sec });
  if (prev == null || sec >= prev || t.pending) return;
  const mode = game.settings.get(MOD, "turnSound");
  if (mode === "none") return;
  if (sec === 0) playSound("end.wav", 0.7);
  else if (mode === "last10" && sec <= 10) playSound(`tick${(sec % 2) + 1}.wav`, 0.8);
}

// Chiffres, couleurs, barres (bandeau et onglet Combat), plusieurs fois par seconde, sans reconstruire.
function updateBanner() {
  const t = currentTimer(game.combat);
  const tracks = document.querySelectorAll(".bt-turn-track span");
  if (!t) return;
  const sec = secondsLeft(t);
  const over = isOver(t);
  const width = `${clamp(1 - elapsedOf(t) / t.duration, 0, 1) * 100}%`;
  for (const bar of tracks) {
    bar.style.width = width;
    bar.parentElement.classList.toggle("is-warn", !over && sec <= WARN_SEC && sec > DANGER_SEC);
    bar.parentElement.classList.toggle("is-danger", over || sec <= DANGER_SEC);
  }
  const root = document.getElementById("bt-turn");
  if (!root || root.hidden) return;
  sounds(t);
  const card = root.querySelector(".bt-turn-card");
  if (!card) return;
  card.classList.toggle("is-done", over);
  card.classList.toggle("is-paused", !over && !t.pending && !isRunning(t));
  card.classList.toggle("is-warn", !over && sec <= WARN_SEC && sec > DANGER_SEC);
  card.classList.toggle("is-danger", !over && sec <= DANGER_SEC);
  card.querySelector(".bt-time").textContent = formatTime(sec);
  card.querySelector(".bt-bar span").style.width = width;
  card.querySelector(".bt-state").textContent = over ? (readTurn(game.combat).autoSkip ? "Tour suivant…" : "Temps écoulé !")
    : t.paused ? "En pause"
    : t.pausedByGame ? "Jeu en pause" : "";
  const toggle = card.querySelector('[data-bt="toggle"]');
  if (toggle) {
    toggle.disabled = over;
    toggle.dataset.tooltip = t.paused ? "Reprendre" : "Pause";
    toggle.firstElementChild.className = `fa-solid fa-${t.paused ? "play" : "pause"}`;
  }
}

/* ---------------------------------------------------------- onglet Combat */

function configHTML(combat) {
  const s = readTurn(combat);
  const min = Math.round(s.duration / 60000);
  const v12 = (game.release?.generation ?? 14) < 13 ? " bt-v12" : "";
  return `<div class="bt-turn-config${s.enabled ? " is-on" : ""}${v12}">
    <button type="button" class="bt-turn-switch" data-bt-turn="toggle" aria-pressed="${s.enabled}">
      <i class="fa-solid fa-hourglass-half"></i><span>Minuteur de tour</span>
      <i class="fa-solid fa-toggle-${s.enabled ? "on" : "off"} bt-turn-flag"></i>
    </button>
    <div class="bt-turn-durations">
      ${TURN_PRESETS.map(m => `<button type="button" data-bt-turn="set" data-min="${m}"${m === min ? ' class="is-active"' : ""}>${m} min</button>`).join("")}
      <span class="bt-turn-step">
        <button type="button" data-bt-turn="step" data-min="-1" data-tooltip="Une minute de moins">−</button>
        <span>${min} min</span>
        <button type="button" data-bt-turn="step" data-min="1" data-tooltip="Une minute de plus">+</button>
      </span>
    </div>
    <button type="button" class="bt-turn-auto${s.autoSkip ? " is-active" : ""}" data-bt-turn="auto" aria-pressed="${s.autoSkip}"
      data-tooltip="Le tour passe tout seul 3 s après la fin du temps">
      <i class="fa-${s.autoSkip ? "solid fa-square-check" : "regular fa-square"}"></i><span>Passer le tour automatiquement à zéro</span>
    </button>
  </div>`;
}

// Foundry v12 : html en jQuery, gabarit AppV1 ; v13 et + : HTMLElement, gabarit AppV2. Les deux ont
// `.combat-tracker-header` et des `li.combatant[data-combatant-id]`.
function onRenderTracker(app, html) {
  const el = html instanceof HTMLElement ? html : html?.[0];
  if (!el) return;
  const combat = app?.viewed ?? game.combat;
  el.querySelectorAll(".bt-turn-config, .bt-turn-track").forEach(n => n.remove());
  if (!combat) return;

  if (game.user.isGM) {
    const header = el.querySelector(".combat-tracker-header") ?? el.querySelector("#combat-round");
    if (header) {
      header.insertAdjacentHTML("beforeend", configHTML(combat));
      header.querySelector(".bt-turn-config").addEventListener("click", event => {
        const b = event.target.closest("[data-bt-turn]");
        if (!b) return;
        event.preventDefault();
        event.stopPropagation();
        const s = readTurn(combat);
        if (b.dataset.btTurn === "toggle") setEnabled(combat, !s.enabled);
        else if (b.dataset.btTurn === "set") setDuration(combat, Number(b.dataset.min) * 60);
        else if (b.dataset.btTurn === "step") setDuration(combat, s.duration / 1000 + Number(b.dataset.min) * 60);
        else if (b.dataset.btTurn === "auto") setAutoSkip(combat, !s.autoSkip);
      });
    }
  }

  // Barre du temps restant sous le combattant actif.
  if (combat === game.combat && currentTimer(combat)) {
    const li = el.querySelector(`li.combatant[data-combatant-id="${combat.combatant.id}"]`);
    if (li) {
      li.classList.add("bt-has-turn");
      li.insertAdjacentHTML("beforeend", `<div class="bt-turn-track"><span></span></div>`);
      updateBanner();
    }
  }
}

/* ------------------------------------------------------------ mise en scène */

let fx = null;          // { root, anim, timers, raf }
let lastStaged = null;  // clé du dernier tour mis en scène (une seule fois par tour)
let blobUrl = null;     // WebP de Safari, chargé une fois

// Calque juste au-dessus de la carte, sous toute l'interface (le plateau est à z 0, l'interface au-dessus).
function ensureFx() {
  if (fx?.root.isConnected) return fx;
  const root = document.createElement("div");
  root.id = "bt-turnfx";
  root.innerHTML = `<div class="bt-turnfx-vignette"></div><div class="bt-turnfx-band is-top"></div><div class="bt-turnfx-band is-bottom"></div>`;
  let anim;
  if (WEBM_ALPHA) {
    anim = document.createElement("video");
    Object.assign(anim, { muted: true, playsInline: true, preload: "auto", src: `${MEDIA}/next-turn.webm` });
    anim.addEventListener("ended", () => anim.classList.remove("is-playing"));
  } else {
    anim = document.createElement("img");
    anim.alt = "";
    fetch(`${MEDIA}/next-turn.webp`).then(r => r.blob()).then(b => { blobUrl = b; }).catch(() => {});
  }
  anim.className = "bt-turnfx-anim";
  root.append(anim);
  const board = document.getElementById("board");
  if (board) board.after(root);
  else document.body.append(root);
  fx = { root, anim, timers: [], raf: null };
  return fx;
}

function stopFx() {
  if (!fx) return;
  fx.timers.forEach(clearTimeout);
  fx.timers = [];
  if (fx.raf) cancelAnimationFrame(fx.raf);
  fx.raf = null;
  fx.root.classList.remove("is-on", "is-active");
  fx.anim.classList.remove("is-playing");
  if (fx.anim.tagName === "VIDEO") fx.anim.pause();
}

const lowQuality = () => canvas.performance?.mode === CONST.CANVAS_PERFORMANCE_MODES?.LOW;

function stage(combat) {
  if (combat.id !== game.combat?.id) return;
  const key = keyOf(combat);
  if (!key || key === lastStaged) return;
  lastStaged = key;
  const mode = game.settings.get(MOD, "turnStaging");
  if (mode === "never" || (mode === "timed" && !isTimed(combat))) return;
  if (!game.settings.get(MOD, "turnStagingClient") || document.hidden || !canvas.ready) return;
  const c = combat.combatant;
  const token = c.token?.object;
  // Jamais vers un jeton que ce joueur ne voit pas (caché, dans le brouillard) : la caméra trahirait sa position.
  if (!token || token.destroyed || c.token.parent?.id !== canvas.scene?.id) return;
  if (!token.visible || (c.hidden && !game.user.isGM)) return;
  focus(token);
}

function focus(token) {
  const scale = Math.max(canvas.stage.scale.x, FOCUS_SCALE);
  canvas.animatePan({ x: token.center.x, y: token.center.y, scale, duration: PAN_MS });
  // Qualité graphique « basse » de Foundry : la caméra seulement.
  if (lowQuality()) return;

  const f = ensureFx();
  stopFx();
  // Le halo est centré sur l'écran : la caméra y amène le jeton. Rayon d'après la taille du jeton après le zoom.
  f.root.style.setProperty("--bt-hole", `${Math.round(Math.max(token.w, token.h) * scale * 0.75)}px`);
  f.root.classList.add("is-active");
  void f.root.offsetWidth; // repart de l'état caché, pour que la transition se joue
  f.root.classList.add("is-on");
  f.timers.push(setTimeout(() => f.root.classList.remove("is-on"), HOLD_MS));
  f.timers.push(setTimeout(() => stopFx(), FX_MS + 400));

  // Animation au-dessus du jeton : suit la caméra et le jeton à chaque image (une transformation, rien d'autre).
  const width = clamp(token.w * scale * 2.4, 260, 560);
  const height = width * ANIM_RATIO;
  Object.assign(f.anim.style, { width: `${width}px`, height: `${height}px` });
  const end = performance.now() + FX_MS;
  const follow = () => {
    if (token.destroyed || performance.now() > end) { f.raf = null; return; }
    const p = canvas.clientCoordinatesFromCanvas?.({ x: token.center.x, y: token.y })
      ?? canvas.stage.worldTransform.apply({ x: token.center.x, y: token.y });
    f.anim.style.transform = `translate3d(${Math.round(p.x - width / 2)}px, ${Math.round(p.y - height * 0.62)}px, 0)`;
    f.raf = requestAnimationFrame(follow);
  };
  follow();
  if (f.anim.tagName === "VIDEO") {
    f.anim.currentTime = 0;
    f.anim.play().then(() => f.anim.classList.add("is-playing")).catch(() => {});
  } else if (blobUrl) {
    // Une URL neuve à chaque fois, pour que le WebP reparte de sa première image.
    if (f.anim.src.startsWith("blob:")) URL.revokeObjectURL(f.anim.src);
    f.anim.src = URL.createObjectURL(blobUrl);
    f.anim.classList.add("is-playing");
  }
}

/* ------------------------------------------------------------------ hooks */

export const turnApi = {
  enable: (combat = game.combat, enabled = true) => setEnabled(combat, enabled),
  setDuration: (seconds, combat = game.combat) => setDuration(combat, seconds),
  addTime: (seconds, combat = game.combat) => addTurnTime(combat?.id, seconds),
  pause: (combat = game.combat) => setPaused(combat, true),
  autoSkip: (enabled = true, combat = game.combat) => setAutoSkip(combat, enabled),
  resume: (combat = game.combat) => setPaused(combat, false)
};
export { addTurnTime };

Hooks.once("init", () => {
  game.settings.register(MOD, "turnStaging", {
    name: "Mise en scène du début de tour",
    hint: "Au début d'un tour, chez tout le monde : caméra centrée et zoomée sur le jeton, bandes noires, et animation « NEXT TURN » au-dessus de lui.",
    scope: "world", config: true, type: String, default: "all",
    choices: { timed: "Tours chronométrés seulement", all: "Tous les combattants visibles", never: "Jamais" }
  });
  game.settings.register(MOD, "turnSound", {
    name: "Sons du minuteur de tour",
    // Tic-tac des 10 dernières secondes par défaut (demandé après les premiers tests).
    scope: "world", config: true, type: String, default: "last10",
    choices: { last10: "Tic-tac des 10 dernières secondes et son de fin", end: "Son de fin seulement", none: "Aucun" }
  });
  game.settings.register(MOD, "turnStagingClient", {
    name: "Mise en scène du tour chez moi",
    hint: "Décocher pour que la caméra ne bouge plus et que l'animation ne s'affiche plus au début des tours, sur cet ordinateur seulement.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MOD, "turnDuration", { scope: "client", config: false, type: Number, default: 120 });
  game.settings.register(MOD, "turnPos", { scope: "client", config: false, type: Object, default: {} });
});

Hooks.on("renderCombatTracker", onRenderTracker);

Hooks.on("updateCombat", (combat, changed) => {
  if ("turn" in changed || "round" in changed) {
    ensureTurn(combat);
    stage(combat);
  }
  if (combat.id === game.combat?.id) renderBanner();
});
for (const hook of ["createCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant", "canvasReady"]) {
  Hooks.on(hook, () => {
    renderBanner();
    ensureTurn(game.combat);
  });
}
Hooks.on("pauseGame", paused => syncGamePause(paused));

Hooks.once("ready", () => {
  const root = ensureRoot("bt-turn");
  makeDraggable(root, "turnPos", false);
  root.addEventListener("click", event => {
    const button = event.target.closest("[data-bt]");
    const combat = game.combats.get(root.dataset.combat);
    if (!button || !combat) return;
    const action = button.dataset.bt;
    if (action === "add") openAddMenu(button, `turn:${combat.id}`);
    else if (action === "toggle") setPaused(combat, !readTurn(combat).timer?.paused);
    else if (action === "skip" || action === "end") combat.nextTurn();
  });
  window.addEventListener("resize", () => { if (!root.hidden) positionBanner(root); });
  ensureFx();

  // Après une relance du monde, l'heure du serveur est repartie de zéro : recaler les minuteurs de tour.
  if (isLeadGM()) for (const combat of game.combats) {
    const t = combat.getFlag(MOD, "turn")?.timer;
    if (t && needsRebase(t)) writeTurn(combat, () => false);
  }
  lastStaged = keyOf(game.combat); // pas de mise en scène au chargement de la page
  renderBanner();
  ensureTurn(game.combat);
  syncGamePause();
  setInterval(() => {
    finishDue();
    autoSkipDue();
    ensureTurn(game.combat);
    updateBanner();
  }, 200);
});
