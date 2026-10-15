// Jukebox Meyiv : musique YouTube partagée, pilotée par le MJ.
// S'appuie sur l'API officielle du lecteur YouTube (IFrame Player API), l'oEmbed de YouTube pour les titres et, avec une
// clé facultative, l'API YouTube Data v3 (durées, longues playlists).
// Seul le MJ écrit, dans deux réglages du monde : « library » (dossiers et morceaux) et « state » (morceau en cours, horodaté
// avec l'heure du serveur). Chaque client, MJ compris, a son lecteur dans son widget et se cale sur « state » : rien ne transite
// pendant la lecture et un F5 reprend au bon moment. Les joueurs renvoient seulement leur statut d'écoute (socket).

const ID = "jukebox-meyiv";
const SOCKET = `module.${ID}`;
const APP_ID = "jukebox-meyiv-app";
const ADD_ID = "jukebox-meyiv-add";
const COLORS = ["#d9534f", "#e8913a", "#d4b13f", "#5fae5a", "#3fb0a8", "#4f8fe0", "#9b6bd6", "#d66ba0", "#8a8f9c", "#b08a5a"];
const MODES = {
  loop: { icon: "fa-repeat", label: "Boucler le dossier", hint: "À la fin du morceau : le suivant du dossier, puis on recommence au début" },
  one: { icon: "fa-repeat", label: "Boucler le son", hint: "À la fin du morceau : on le rejoue", one: true },
  shuffle: { icon: "fa-shuffle", label: "Aléatoire", hint: "À la fin du morceau : un autre au hasard dans le dossier, sans répétition tant que tout n'est pas passé" }
};
// Codes de l'événement onError du lecteur (doc de l'IFrame Player API).
const YT_ERRORS = { 2: "lien invalide", 5: "erreur du lecteur", 100: "vidéo introuvable ou privée", 101: "intégration interdite par l'auteur", 150: "intégration interdite par l'auteur" };
const LISTEN_LABELS = { ok: "", idle: "", blocked: "son pas activé", muted: "son coupé", error: "lecture impossible" };

/* ----------------------------------------------------------------- outils */

const now = () => game.time.serverTime;
const sessionStart = () => Date.now() - game.time.serverTime;
const setting = key => game.settings.get(ID, key);
const isLeadGM = () => !!game.users.activeGM?.isSelf;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const thumb = (v, size = "default") => `https://i.ytimg.com/vi/${v}/${size}.jpg`;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Écritures à la file, pour que deux clics rapprochés ne s'écrasent pas.
function queue() {
  let chain = Promise.resolve();
  return fn => (chain = chain.then(fn).catch(err => console.error(`${ID} |`, err)));
}

/* ------------------------------------------------------------ bibliothèque */

const readLibrary = () => {
  const L = game.settings.get(ID, "library");
  return Array.isArray(L?.folders) ? L : { folders: [] };
};
const findFolder = (id, L = readLibrary()) => L.folders.find(f => f.id === id) ?? null;
function findTrack(k, L = readLibrary()) {
  if (!k) return null;
  for (const folder of L.folders) {
    const index = folder.tracks.findIndex(t => t.k === k);
    if (index >= 0) return { folder, index, track: folder.tracks[index] };
  }
  return null;
}
const findVideo = (v, L = readLibrary()) => L.folders.find(f => f.tracks.some(t => t.v === v)) ?? null;
const makeFolder = (name, L) => ({ id: foundry.utils.randomID(), name, color: COLORS[L.folders.length % COLORS.length], tracks: [] });
const makeTrack = ({ v, title, dur }) => ({ k: foundry.utils.randomID(), v, title: String(title || v).trim(), ...(dur ? { dur } : {}) });

const libQueue = queue();
// fn modifie une copie de la bibliothèque ; si elle renvoie false, rien n'est écrit.
function editLibrary(fn) {
  if (!game.user.isGM) return Promise.resolve();
  return libQueue(async () => {
    const L = foundry.utils.deepClone(readLibrary());
    if (fn(L) === false) return;
    await game.settings.set(ID, "library", L);
  });
}

// Bibliothèque de YouTube Jukebox ({ groups: [{ name, items: [{ id, title }] }] }) → dossiers.
function convertOldLibrary(old, L) {
  const folders = [];
  for (const g of old?.groups ?? []) {
    const f = makeFolder(g.name === "Unsorted" ? "Non classé" : String(g.name || "Dossier"), { folders: [...L.folders, ...folders] });
    f.tracks = (g.items ?? []).filter(it => it?.id).map(it => makeTrack({ v: it.id, title: it.title }));
    folders.push(f);
  }
  return folders;
}

function readOldLibrary() {
  try { if (game.modules.get("yt-jukebox")?.active) return game.settings.get("yt-jukebox", "library"); } catch {}
  const doc = game.settings.storage.get("world")?.find(s => s.key === "yt-jukebox.library");
  let value = doc?.value;
  try { if (typeof value === "string") value = JSON.parse(value); } catch { return null; }
  return value ?? null;
}

// Premier lancement : reprend la bibliothèque de YouTube Jukebox (sans y toucher).
async function migrate() {
  if (setting("imported")) return;
  const L = { folders: [] };
  L.folders = convertOldLibrary(readOldLibrary(), L).filter(f => f.tracks.length || f.name !== "Non classé");
  if (!L.folders.some(f => f.name === "Non classé")) L.folders.push(makeFolder("Non classé", L));
  if (!readLibrary().folders.length) await game.settings.set(ID, "library", L);
  await game.settings.set(ID, "imported", true);
  const n = L.folders.reduce((a, f) => a + f.tracks.length, 0);
  if (n) ui.notifications.info(`Jukebox : ${plural(n, "morceau repris", "morceaux repris")} de YouTube Jukebox.`);
}

/* -------------------------------------------------------- lecture en cours */

// Deux canaux, écrits par le MJ seul : « state » = musique générale, « target » = son ciblé (target.targets = joueurs
// qui l'entendent ; le MJ l'entend aussi). Chaque client n'écoute qu'un canal : un seul lecteur YouTube.
const CHANNELS = ["state", "target"];
const readChannel = key => ({ status: "stop", mode: "loop", pos: 0, at: 0, ...game.settings.get(ID, key) });
const readState = () => readChannel("state");
const readTarget = () => readChannel("target");
// L'heure du serveur repart de zéro quand le monde est relancé : un état d'une session précédente ne vaut plus rien.
// Le MJ le reconnaît à `session` (écrite avec l'horloge de sa machine). Un joueur, dont l'horloge peut être décalée
// de celle du MJ, ne regarde que l'heure du serveur : un horodatage dans le futur vient forcément d'une session
// précédente. Au lancement du monde, le MJ actif remet de toute façon ces états à l'arrêt.
const isStale = s => s.session != null && (game.user.isGM
  ? Math.abs(s.session - sessionStart()) > 60000
  : (s.at || 0) > now() + 10000);
const isLive = s => s.status !== "stop" && !!s.v && !isStale(s);
const positionOf = (s, at = now()) => (s.pos || 0) + (s.status === "play" ? Math.max(0, at - s.at) / 1000 : 0);
const targetsOf = t => (!isStale(t) && Array.isArray(t.targets) && t.targets.length ? t.targets : null);
const userNames = ids => ids.map(id => game.users.get(id)?.name ?? "?").join(", ");

// Canal écouté ici : le son ciblé si on en fait partie (le MJ toujours), sinon la musique générale.
function heardKey() {
  const t = targetsOf(readTarget());
  return t && (game.user.isGM || t.includes(game.user.id)) ? "target" : "state";
}
// Canal piloté par les commandes du MJ : le son ciblé tant qu'il existe.
const ctlKey = () => (targetsOf(readTarget()) ? "target" : "state");
// Pendant un son ciblé, la musique générale boucle sur son morceau chez les autres (calcul local, sans écriture du MJ).
const generalLoops = key => key === "state" && !!targetsOf(readTarget());

const queues = { state: queue(), target: queue() };
function setChannel(key, patch) {
  if (!game.user.isGM || !patch) return Promise.resolve();
  return queues[key](() => game.settings.set(ID, key, { ...readChannel(key), ...patch, session: sessionStart() }));
}
const setState = patch => setChannel("state", patch);

function trackPatch(k) {
  const hit = findTrack(k);
  return hit ? { status: "play", track: k, v: hit.track.v, title: hit.track.title, pos: 0, at: now() } : null;
}

// Lancement à la main : vers les joueurs cochés dans « Qui entend ? » (son ciblé), sinon vers tout le monde.
function playTrack(k) {
  const patch = trackPatch(k);
  if (!patch) return;
  const audience = Library.audience.filter(id => game.users.get(id));
  if (audience.length) return setChannel("target", { ...patch, targets: audience });
  if (targetsOf(readTarget())) setChannel("target", { targets: null, status: "stop", pos: 0, at: now() });
  return setState(patch);
}

// « Revenir à tout le monde » : le son ciblé s'arrête, les joueurs ciblés retrouvent la musique générale.
// Elle a tourné en boucle entre-temps : on recale d'abord sa position dans le morceau, puis on retire la cible.
async function backToAll() {
  Library.audience = [];
  Library.refreshAudience();
  if (!targetsOf(readTarget())) return;
  const g = readState();
  if (isLive(g) && g.status === "play") {
    const dur = findTrack(g.track)?.track.dur;
    await setState({ pos: dur ? positionOf(g) % dur : 0, at: now() });
  }
  return setChannel("target", { targets: null, status: "stop", pos: 0, at: now() });
}

function playFolder(folderId) {
  const f = findFolder(folderId);
  if (!f?.tracks.length) return;
  const i = readState().mode === "shuffle" ? Math.floor(Math.random() * f.tracks.length) : 0;
  shuffleBags.state = shuffleBags.target = null;
  return playTrack(f.tracks[i].k);
}

function togglePlay() {
  const key = ctlKey();
  const s = readChannel(key);
  if (s.status === "play" && isLive(s)) return setChannel(key, { status: "pause", pos: positionOf(s), at: now() });
  if (s.status === "pause" && isLive(s)) return setChannel(key, { status: "play", at: now() });
  if (findTrack(s.track)) return setChannel(key, trackPatch(s.track));
  const L = readLibrary();
  const f = findFolder(Library.sel, L)?.tracks.length ? findFolder(Library.sel, L) : L.folders.find(x => x.tracks.length);
  if (f) return playFolder(f.id);
}

const stopChannel = key => setChannel(key, { status: "stop", pos: 0, at: now() });
const stopPlay = () => stopChannel(ctlKey());
function seek(sec) {
  const key = ctlKey();
  if (isLive(readChannel(key))) return setChannel(key, { pos: Math.max(0, sec), at: now() });
}
// Le mode est commun aux deux canaux (rangé dans « state »).
function setMode(mode) {
  shuffleBags.state = shuffleBags.target = null;
  return setState({ mode });
}
function cycleMode() {
  const keys = Object.keys(MODES);
  return setMode(keys[(keys.indexOf(readState().mode) + 1) % keys.length]);
}

// Aléatoire : tout le dossier passe une fois, dans le désordre, avant de rebattre (un sac par canal, gardé par le MJ).
const shuffleBags = { state: null, target: null };
function nextShuffle(folder, index, key) {
  const keys = folder.tracks.map(t => t.k);
  if (keys.length < 2) return 0;
  let bag = shuffleBags[key];
  if (!bag || bag.folder !== folder.id || !bag.keys.length) {
    const list = keys.filter(k => k !== keys[index]);
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    bag = shuffleBags[key] = { folder: folder.id, keys: list };
  }
  while (bag.keys.length) {
    const i = keys.indexOf(bag.keys.pop());
    if (i >= 0) return i;
  }
  return (index + 1) % keys.length;
}

function step(dir, auto = false, key = ctlKey()) {
  const s = readChannel(key);
  const hit = findTrack(s.track);
  if (!hit) return stopChannel(key);
  const mode = readState().mode;
  if (auto && mode === "one") return setChannel(key, { status: "play", pos: 0, at: now() });
  const len = hit.folder.tracks.length;
  const i = dir > 0 && mode === "shuffle" ? nextShuffle(hit.folder, hit.index, key) : (hit.index + dir + len) % len;
  return setChannel(key, trackPatch(hit.folder.tracks[i].k));
}

/* ---------------------------------------------------------- lecteur YouTube */

// API du lecteur YouTube : on ajoute son script une seule fois, puis on attend que YT.Player existe (vérification toutes
// les 100 ms, abandon au bout de 20 s). On ne touche pas à onYouTubeIframeAPIReady, qu'un autre module peut utiliser.
let ytReady = null;
function loadYouTubeAPI() {
  ytReady ??= new Promise((resolve, reject) => {
    if (!window.YT?.Player && !document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      document.head.append(Object.assign(document.createElement("script"), { src: "https://www.youtube.com/iframe_api" }));
    }
    const since = Date.now();
    const check = () => {
      if (window.YT?.Player) return resolve();
      if (Date.now() - since > 20000) { ytReady = null; return reject(new Error("API du lecteur YouTube injoignable")); }
      setTimeout(check, 100);
    };
    check();
  });
  return ytReady;
}

// Paramètres du lecteur (doc « Player parameters ») : ni commandes ni clavier (tout passe par le jukebox),
// pas d'annotations, pas de plein écran, suggestions de fin limitées à la même chaîne.
const PLAYER_VARS = { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0 };

// États YouTube : -1 pas démarré, 0 terminé, 1 lecture, 2 pause, 3 chargement, 5 prêt (vidéo chargée sans lecture).
const Player = {
  yt: null,
  ready: null,
  video: null,
  blocked: false,
  error: null,
  errorStreak: 0,
  ensure() {
    this.ready ??= loadYouTubeAPI().catch(err => { this.ready = null; throw err; }).then(() => new Promise(resolve => {
      this.yt = new YT.Player("jbm-player", {
        width: "100%",
        height: "100%",
        playerVars: { ...PLAYER_VARS, origin: window.location.origin },
        events: {
          onReady: () => resolve(this.yt),
          onStateChange: e => onPlayerState(e.data),
          onError: e => onPlayerError(e.data)
        }
      });
    }));
    return this.ready;
  },
  get state() { try { return this.yt?.getPlayerState?.() ?? -1; } catch { return -1; } },
  get time() { try { return this.yt?.getCurrentTime?.() ?? 0; } catch { return 0; } },
  get duration() { try { return this.yt?.getDuration?.() ?? 0; } catch { return 0; } },
  call(fn, ...args) { try { this.yt?.[fn]?.(...args); } catch (err) { console.warn(`${ID} | ${fn}`, err); } }
};

// Cale le lecteur local sur l'état du MJ. Appelé à chaque changement d'état ; un seul passage à la fois.
let applying = false, applyAgain = false;
async function apply() {
  if (applying) { applyAgain = true; return; }
  applying = true;
  try {
    do { applyAgain = false; await applyOnce(); } while (applyAgain);
  } finally { applying = false; }
}

// Position à jouer ; pendant un son ciblé, la musique générale boucle sur son morceau (même calcul chez tous les autres).
function playPosition(key, s) {
  const pos = positionOf(s);
  if (!generalLoops(key)) return pos;
  const dur = (Player.video === s.v && Player.duration) || findTrack(s.track)?.track.dur || 0;
  return dur ? pos % dur : pos;
}

async function applyOnce() {
  const key = heardKey();
  const s = readChannel(key);
  Widget.update();
  if (!isLive(s)) {
    if (Player.yt) Player.call("pauseVideo");
    setBlocked(false);
    report();
    return;
  }
  if (!(await Player.ensure().catch(() => null))) {
    Player.error = "lecteur YouTube injoignable";
    Widget.update();
    report();
    return;
  }
  const target = playPosition(key, s);
  const st = Player.state;
  if (Player.video !== s.v) {
    Player.video = s.v;
    Player.error = null;
    Player.call(s.status === "play" ? "loadVideoById" : "cueVideoById", { videoId: s.v, startSeconds: target });
  } else if (s.status === "play") {
    if (Math.abs(Player.time - target) > 2) Player.call("seekTo", target, true);
    if (st !== 1 && st !== 3) Player.call("playVideo");
  } else {
    if (st === 1 || st === 3) Player.call("pauseVideo");
    // seekTo relance la lecture sauf depuis la pause : on ne recale que si le lecteur joue ou est en pause.
    if ([1, 2, 3].includes(st) && Math.abs(Player.time - target) > 1) Player.call("seekTo", target, true);
  }
  applyVolume();
  if (s.status === "play") watchAutoplay();
  Widget.update();
  report();
}

// Toutes les 3 s : si le lecteur a dérivé de plus de 3 s (coupure réseau, onglet en veille), on le recale.
function correctDrift() {
  const key = heardKey();
  const s = readChannel(key);
  if (!isLive(s) || s.status !== "play" || Player.video !== s.v || Player.state !== 1) return;
  const target = playPosition(key, s);
  const dur = Player.duration;
  if (dur && target > dur) return;
  if (Math.abs(Player.time - target) > 3) Player.call("seekTo", target, true);
}

function applyVolume() {
  if (!Player.yt?.setVolume) return;
  Player.call("setVolume", setting("volume"));
  Player.call(setting("muted") ? "mute" : "unMute");
}

// Le navigateur refuse souvent le son tant qu'on n'a pas cliqué dans la page : on le détecte et le premier clic relance.
let watchTimer = null;
function watchAutoplay() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const s = readChannel(heardKey());
    if (!isLive(s) || s.status !== "play" || Player.error) return setBlocked(false);
    const st = Player.state;
    const silenced = !setting("muted") && !!Player.yt?.isMuted?.();
    setBlocked(!(st === 1 || st === 3) || silenced);
  }, 2500);
}

function setBlocked(blocked) {
  document.removeEventListener("pointerdown", unlockAudio, true);
  if (blocked) document.addEventListener("pointerdown", unlockAudio, { capture: true, once: true });
  if (Player.blocked === blocked) return;
  Player.blocked = blocked;
  Widget.update();
  report();
}

function unlockAudio() {
  if (!Player.blocked) return;
  if (!setting("muted")) Player.call("unMute");
  Player.call("playVideo");
  watchAutoplay();
}

function onPlayerState(st) {
  const key = heardKey();
  const s = readChannel(key);
  if (st === 1) {
    Player.error = null;
    Player.errorStreak = 0;
    if (Player.blocked && !(!setting("muted") && Player.yt?.isMuted?.())) setBlocked(false);
    rememberDuration(s);
  }
  // Fin du morceau : le MJ actif enchaîne (5 s minimum : un second signal pour le même morceau est ignoré).
  // Pendant un son ciblé, la musique générale reboucle simplement chez les autres.
  if (st === 0 && s.status === "play" && s.v === Player.video) {
    if (generalLoops(key)) { Player.call("seekTo", playPosition(key, s), true); Player.call("playVideo"); }
    else if (isLeadGM() && positionOf(s) >= 5) step(1, true, key);
  }
  Widget.update();
  Library.refreshNow();
  report();
}

function onPlayerError(code) {
  const key = heardKey();
  const s = readChannel(key);
  Player.error = YT_ERRORS[code] ?? "lecture impossible";
  Widget.update();
  report();
  if (!isLeadGM() || s.status !== "play") return;
  ui.notifications.warn(`Jukebox : « ${s.title ?? "?"} » ne peut pas être lu (${Player.error}).`);
  const len = findTrack(s.track)?.folder.tracks.length ?? 0;
  if (++Player.errorStreak < len) setTimeout(() => step(1, false, key), 1500);
}

// Le MJ note la durée d'un morceau la première fois qu'il passe (affichée ensuite dans la bibliothèque).
function rememberDuration(s) {
  if (!isLeadGM() || Player.video !== s.v) return;
  const dur = Math.round(Player.duration);
  const hit = findTrack(s.track);
  if (!(dur > 0) || !hit || hit.track.dur === dur) return;
  editLibrary(L => {
    const h = findTrack(s.track, L);
    if (!h) return false;
    h.track.dur = dur;
  });
}

/* ------------------------------------------------------ statut des joueurs */

let lastReport = null;
function listenStatus() {
  if (!isLive(readChannel(heardKey()))) return "idle";
  if (Player.error) return "error";
  if (Player.blocked) return "blocked";
  if (setting("muted") || !setting("volume")) return "muted";
  return "ok";
}

function report(force = false) {
  if (game.user.isGM) return;
  const status = listenStatus();
  if (!force && status === lastReport) return;
  lastReport = status;
  game.socket.emit(SOCKET, { type: "status", user: game.user.id, status });
}

const listeners = new Map();
function onSocket(msg) {
  if (msg?.type === "ping" && !game.user.isGM) report(true);
  if (msg?.type === "status" && game.user.isGM) {
    listeners.set(msg.user, msg.status);
    Library.refreshFoot();
  }
}

/* ------------------------------------------------------------ déplacement */

const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));
function place(el, left, top) {
  const { width, height } = el.getBoundingClientRect();
  Object.assign(el.style, {
    left: `${clamp(left, 0, window.innerWidth - width)}px`,
    top: `${clamp(top, 0, window.innerHeight - height)}px`,
    right: "auto",
    bottom: "auto"
  });
}

function restorePosition(el, key) {
  const pos = setting(key);
  if (el.hidden || pos?.left == null) return;
  place(el, pos.left, pos.top);
}

// Déplacement par les zones [data-drag] ; au-delà de 4 px c'est un déplacement, sinon un clic normal.
function makeDraggable(el, key) {
  el.addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-drag]");
    if (event.button !== 0 || !handle || !el.contains(handle)) return;
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    const x0 = event.clientX, y0 = event.clientY;
    let moved = false;
    const move = e => {
      if (!moved) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
        moved = true;
        el.classList.add("is-dragging");
        try { el.setPointerCapture(event.pointerId); } catch {}
      }
      place(el, e.clientX - dx, e.clientY - dy);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      if (!moved) return;
      el.classList.remove("is-dragging");
      el.dataset.dragged = "1";
      setTimeout(() => delete el.dataset.dragged, 0);
      game.settings.set(ID, key, { left: parseFloat(el.style.left), top: parseFloat(el.style.top) });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  });
}

/* ----------------------------------------------------------------- widget */

// Construit une seule fois : le lecteur YouTube est une iframe, la déplacer dans la page la rechargerait.
// Les différents aspects (déplié, réduit, sans vidéo) ne changent que des classes.
const Widget = {
  el: null,
  banner: null,

  build() {
    const gm = game.user.isGM;
    const el = document.createElement("section");
    el.id = "jbm-widget";
    el.className = `jbm-ui jbm-widget${gm ? " is-gm" : ""}`;
    el.innerHTML = `
      <div class="jbm-w-vid"><div id="jbm-player"></div></div>
      <div class="jbm-w-info" data-drag>
        <div class="jbm-w-k"></div>
        <div class="jbm-w-title"></div>
      </div>
      <div class="jbm-w-btns">
        ${gm ? `<button type="button" class="jbm-ibtn" data-w="library" data-tooltip="Ouvrir la bibliothèque"><i class="fa-solid fa-list"></i></button>` : ""}
        <button type="button" class="jbm-ibtn" data-w="more" data-tooltip="Plus d'options"><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <button type="button" class="jbm-w-icon" data-w="restore" data-drag data-tooltip="Jukebox : rouvrir le widget"><i class="fa-solid fa-music"></i></button>
      ${gm ? `<div class="jbm-w-ctl">
        <button type="button" class="jbm-ibtn" data-w="prev" data-tooltip="Précédent"><i class="fa-solid fa-backward-step"></i></button>
        <button type="button" class="jbm-ibtn jbm-main" data-w="toggle" data-tooltip="Lecture / pause"><i class="fa-solid fa-play"></i></button>
        <button type="button" class="jbm-ibtn" data-w="stop" data-tooltip="Stop"><i class="fa-solid fa-stop"></i></button>
        <button type="button" class="jbm-ibtn" data-w="next" data-tooltip="Suivant"><i class="fa-solid fa-forward-step"></i></button>
        <button type="button" class="jbm-ibtn jbm-w-mode" data-w="mode"></button>
        <button type="button" class="jbm-ibtn jbm-w-back" data-w="back" hidden><i class="fa-solid fa-users"></i></button>
      </div>` : ""}
      <div class="jbm-w-vol">
        <button type="button" class="jbm-ibtn" data-w="mute" data-tooltip="Couper le son"><i class="fa-solid fa-volume-low"></i></button>
        <input type="range" min="0" max="100" step="1" class="jbm-w-range">
        <span class="jbm-w-v"></span>
      </div>
      <div class="jbm-w-more">
        <label class="jbm-opt"><input type="checkbox" data-opt="showVideo"><span>Afficher la vidéo</span></label>
        <label class="jbm-opt"><input type="checkbox" data-opt="minimized"><span>Réduire à une icône<small>Clic sur l'icône pour revenir.</small></span></label>
      </div>`;
    document.body.append(el);
    this.el = el;

    const banner = document.createElement("div");
    banner.id = "jbm-banner";
    banner.className = "jbm-ui jbm-banner";
    banner.hidden = true;
    banner.innerHTML = `<i class="fa-solid fa-volume-xmark"></i> Ton navigateur bloque le son du jukebox <button type="button">Activer le son</button>`;
    banner.querySelector("button").addEventListener("click", () => { banner.hidden = true; });
    document.body.append(banner);
    this.banner = banner;

    el.addEventListener("click", event => {
      const btn = event.target.closest("[data-w]");
      if (!btn || el.dataset.dragged) return;
      switch (btn.dataset.w) {
        case "library": return openLibrary();
        case "more": return game.settings.set(ID, "widgetOpen", !setting("widgetOpen"));
        case "restore": return game.settings.set(ID, "minimized", false);
        case "mute": return game.settings.set(ID, "muted", !setting("muted"));
        case "prev": return step(-1);
        case "next": return step(1);
        case "toggle": return togglePlay();
        case "stop": return stopPlay();
        case "mode": return cycleMode();
        case "back": return backToAll();
      }
    });
    const range = el.querySelector(".jbm-w-range");
    range.addEventListener("input", () => {
      el.querySelector(".jbm-w-v").textContent = range.value;
      Player.call("setVolume", Number(range.value));
    });
    range.addEventListener("change", () => game.settings.set(ID, "volume", Number(range.value)));
    el.addEventListener("change", event => {
      const opt = event.target.dataset?.opt;
      if (opt) game.settings.set(ID, opt, event.target.checked);
    });
    makeDraggable(el, "widgetPos");
    window.addEventListener("resize", () => restorePosition(el, "widgetPos"));
    this.update();
  },

  update() {
    const el = this.el;
    if (!el) return;
    const s = readChannel(heardKey());
    const gm = game.user.isGM;
    const live = isLive(s);
    const folder = live ? findTrack(s.track)?.folder : null;
    const targets = gm ? targetsOf(readTarget()) : null;
    const wasHidden = el.hidden;
    el.hidden = !gm && !live;
    el.classList.toggle("is-open", setting("widgetOpen"));
    el.classList.toggle("is-mini", setting("minimized"));
    el.classList.toggle("no-video", !setting("showVideo") || !live);
    el.classList.toggle("is-playing", live && s.status === "play");

    const label = !live ? "Rien en cours"
      : Player.error ? "Lecture impossible"
      : s.status === "pause" ? "En pause" : "En lecture";
    const stateCls = !live || Player.error ? "is-off" : s.status === "pause" ? "is-paused" : "";
    const folderHTML = gm && folder ? ` · <span class="jbm-dot" style="--fc:${folder.color}"></span>${esc(folder.name)}` : "";
    el.querySelector(".jbm-w-k").innerHTML = `<span class="jbm-state ${stateCls}">${label}</span>${folderHTML}`;
    el.classList.toggle("is-targeted", !!targets);
    const back = el.querySelector(".jbm-w-back");
    if (back) {
      back.hidden = !targets;
      back.dataset.tooltip = targets ? `Son ciblé (${userNames(targets)}) : revenir à tout le monde` : "";
    }
    const title = el.querySelector(".jbm-w-title");
    title.textContent = live ? s.title || "—" : gm ? "Ouvre la bibliothèque pour lancer une musique" : "—";
    title.dataset.tooltip = Player.error ? `Lecture impossible : ${Player.error}` : "";

    el.querySelector('[data-w="more"] i').className = `fa-solid fa-chevron-${setting("widgetOpen") ? "up" : "down"}`;
    const toggle = el.querySelector('[data-w="toggle"] i');
    if (toggle) toggle.className = `fa-solid fa-${live && s.status === "play" ? "pause" : "play"}`;
    const modeBtn = el.querySelector(".jbm-w-mode");
    if (modeBtn) {
      const m = MODES[s.mode] ?? MODES.loop;
      modeBtn.innerHTML = `<i class="fa-solid ${m.icon}"></i>${m.one ? `<span class="jbm-one">1</span>` : ""}`;
      modeBtn.dataset.tooltip = `Mode : ${m.label} (clic pour changer)`;
    }
    const muted = setting("muted");
    el.querySelector('[data-w="mute"] i').className = `fa-solid fa-volume-${muted ? "xmark" : "low"}`;
    el.querySelector('[data-w="mute"]').dataset.tooltip = muted ? "Remettre le son" : "Couper le son";
    const range = el.querySelector(".jbm-w-range");
    if (document.activeElement !== range) range.value = setting("volume");
    range.disabled = muted;
    el.querySelector(".jbm-w-v").textContent = muted ? "—" : range.value;
    for (const box of el.querySelectorAll("[data-opt]")) box.checked = !!setting(box.dataset.opt);

    this.banner.hidden = !Player.blocked;
    if (wasHidden && !el.hidden || !el.style.left) restorePosition(el, "widgetPos");
  }
};

/* ------------------------------------------------------------------- menus */

let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }

// Petit menu flottant ; anchor = élément (ouvert dessous) ou événement (ouvert sous la souris).
function openMenu(anchor, html, onPick) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "jbm-ui jbm-menu";
  menuEl.innerHTML = html;
  document.body.append(menuEl);
  let x, y;
  if (anchor instanceof Event) { x = anchor.clientX; y = anchor.clientY; }
  else { const r = anchor.getBoundingClientRect(); x = r.right - menuEl.offsetWidth; y = r.bottom + 4; }
  menuEl.style.left = `${clamp(x, 6, window.innerWidth - menuEl.offsetWidth - 6)}px`;
  menuEl.style.top = `${clamp(y, 6, window.innerHeight - menuEl.offsetHeight - 6)}px`;
  menuEl.addEventListener("click", event => {
    const el = event.target.closest("[data-m]");
    if (!el || el.classList.contains("is-off")) return;
    event.stopPropagation();
    closeMenu();
    onPick(el.dataset.m, el);
  });
}
document.addEventListener("pointerdown", event => { if (menuEl && !menuEl.contains(event.target)) closeMenu(); }, true);

// Annonce en bas d'écran avec « Annuler » (6 s), à la place des fenêtres de confirmation.
let toastEl = null, toastTimer = null;
function toastUndo(label, undo) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = document.createElement("div");
  toastEl.className = "jbm-ui jbm-toast";
  toastEl.innerHTML = `<span><i class="fa-solid fa-trash"></i> ${esc(label)}</span><button type="button">Annuler</button>`;
  toastEl.querySelector("button").addEventListener("click", () => { toastEl.remove(); undo(); });
  document.body.append(toastEl);
  const el = toastEl;
  toastTimer = setTimeout(() => el.remove(), 6000);
}

async function askText(title, label, value = "") {
  const text = await foundry.applications.api.DialogV2.prompt({
    window: { title },
    position: { width: 400 },
    content: `<div class="form-group"><label>${esc(label)}</label><input type="text" name="text" value="${esc(value)}" autofocus></div>`,
    ok: { label: "Valider", icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.text.value.trim() },
    rejectClose: false
  });
  return text || null;
}

/* ------------------------------------------------------ actions du MJ */

function moveTracks(keys, folderId, beforeKey = null) {
  keys = keys.filter(k => k !== beforeKey);
  if (!keys.length) return;
  editLibrary(L => {
    const dest = findFolder(folderId, L);
    if (!dest) return false;
    const moving = [];
    for (const k of keys) {
      const h = findTrack(k, L);
      if (!h) continue;
      moving.push(h.track);
      h.folder.tracks.splice(h.index, 1);
    }
    const at = beforeKey ? dest.tracks.findIndex(t => t.k === beforeKey) : -1;
    dest.tracks.splice(at < 0 ? dest.tracks.length : at, 0, ...moving);
  });
}

function deleteTracks(keys) {
  if (!keys.length) return;
  const before = foundry.utils.deepClone(readLibrary());
  const first = findTrack(keys[0], before)?.track;
  editLibrary(L => {
    for (const k of keys) {
      const h = findTrack(k, L);
      if (h) h.folder.tracks.splice(h.index, 1);
    }
  });
  for (const k of keys) Library.picked.delete(k);
  for (const key of CHANNELS) if (keys.includes(readChannel(key).track)) stopChannel(key);
  toastUndo(keys.length > 1 ? `${keys.length} morceaux supprimés` : `« ${first?.title ?? "?"} » supprimé`,
    () => editLibrary(L => { L.folders = before.folders; }));
}

function deleteFolder(folderId) {
  const before = foundry.utils.deepClone(readLibrary());
  const f = findFolder(folderId, before);
  if (!f) return;
  for (const key of CHANNELS) if (f.tracks.some(t => t.k === readChannel(key).track)) stopChannel(key);
  editLibrary(L => { L.folders = L.folders.filter(x => x.id !== folderId); });
  toastUndo(`Dossier « ${f.name} » supprimé`, () => editLibrary(L => { L.folders = before.folders; }));
}

async function renameTrack(k) {
  const t = findTrack(k)?.track;
  if (!t) return;
  const title = await askText("Renommer le morceau", "Titre", t.title);
  if (!title) return;
  await editLibrary(L => { const h = findTrack(k, L); if (!h) return false; h.track.title = title; });
  for (const key of CHANNELS) if (readChannel(key).track === k) setChannel(key, { title });
}

async function renameFolder(folderId) {
  const f = findFolder(folderId);
  if (!f) return;
  const name = await askText("Renommer le dossier", "Nom du dossier", f.name);
  if (name) editLibrary(L => { const x = findFolder(folderId, L); if (!x) return false; x.name = name; });
}

async function createFolder() {
  const name = await askText("Nouveau dossier", "Nom du dossier", "Nouveau dossier");
  if (!name) return;
  let id;
  await editLibrary(L => { const f = makeFolder(name, L); id = f.id; L.folders.push(f); });
  Library.select(id);
}

function exportLibrary() {
  foundry.utils.saveDataToFile(JSON.stringify(readLibrary(), null, 2), "application/json", "jukebox-meyiv.json");
}

// Importe un fichier du Jukebox Meyiv ou de YouTube Jukebox : les dossiers s'ajoutent à la suite.
function importLibrary() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return ui.notifications.error("Ce fichier n'est pas un JSON valide."); }
    let added = 0;
    await editLibrary(L => {
      const folders = Array.isArray(data?.folders)
        ? data.folders.map(f => ({ ...makeFolder(String(f.name || "Dossier"), L), color: f.color || COLORS[0], tracks: (f.tracks ?? []).filter(t => t?.v).map(makeTrack) }))
        : convertOldLibrary(data, L);
      if (!folders.length) return false;
      added = folders.reduce((a, f) => a + f.tracks.length, 0);
      L.folders.push(...folders);
    });
    if (added) ui.notifications.info(`Jukebox : ${plural(added, "morceau importé", "morceaux importés")}.`);
    else ui.notifications.warn("Aucun morceau trouvé dans ce fichier.");
  });
  input.click();
}

/* ------------------------------------------------------- fenêtre du MJ */

const { ApplicationV2 } = foundry.applications.api;

const Library = {
  sel: null,
  query: "",
  picked: new Set(),
  anchor: null,
  dragged: [],

  el: null, // contenu de la fenêtre ouverte (posé par JukeboxApp)
  audience: [], // joueurs cochés dans « Qui entend ? » (vide = tout le monde)
  root() { return this.el; },
  folder(L = readLibrary()) {
    if (!findFolder(this.sel, L)) this.sel = L.folders[0]?.id ?? null;
    return findFolder(this.sel, L);
  },
  select(id) {
    this.sel = id;
    this.query = "";
    this.picked.clear();
    const root = this.root();
    if (root) root.querySelector(".jbm-q").value = "";
    this.refresh();
  },

  refresh() {
    if (!this.root()) return;
    this.refreshFolders();
    this.refreshTracks();
    this.refreshNow();
    this.refreshAudience();
    this.refreshFoot();
  },

  // « Qui entend ? » (préparation du prochain lancement) et bandeau du son ciblé en cours.
  refreshAudience() {
    const root = this.root();
    if (!root) return;
    const s = readState();
    this.audience = this.audience.filter(id => game.users.get(id));
    const all = !this.audience.length;
    const players = game.users.filter(u => !u.isGM && (u.active || this.audience.includes(u.id)));
    root.querySelector(".jbm-aud-chips").innerHTML = `<button type="button" class="jbm-aud${all ? " is-on" : ""}" data-act="aud-all"><i class="fa-solid fa-users"></i> Tout le monde</button>`
      + players.map(u => `<button type="button" class="jbm-aud${this.audience.includes(u.id) ? " is-on" : ""}${u.active ? "" : " is-away"}" data-act="aud-user" data-user="${u.id}"${u.active ? "" : ` data-tooltip="Déconnecté"`}>${esc(u.name)}</button>`).join("")
      + (players.length ? "" : `<span class="jbm-muted">aucun joueur connecté</span>`);
    root.querySelector(".jbm-aud-hint").textContent = all ? "" : `Le prochain morceau lancé ne sera entendu que par ${userNames(this.audience)}.`;
    const t = targetsOf(readTarget());
    const banner = root.querySelector(".jbm-target");
    banner.hidden = !t;
    if (t) banner.querySelector(".jbm-target-txt").innerHTML = `<i class="fa-solid fa-crosshairs"></i> Son ciblé : <b>${esc(userNames(t))}</b>`
      + `<span class="jbm-target-next"> · ${isLive(s) ? `les autres entendent « ${esc(s.title)} » en boucle` : "les autres n'entendent rien"}</span>`;
  },

  refreshFolders() {
    const root = this.root();
    if (!root) return;
    const L = readLibrary();
    const cur = this.folder(L);
    const s = readChannel(ctlKey());
    const playingFolder = isLive(s) ? findTrack(s.track, L)?.folder.id : null;
    root.querySelector(".jbm-folders").innerHTML = L.folders.map(f => {
      const sel = f === cur && !this.query;
      return `<div class="jbm-folder${sel ? " is-sel" : ""}" data-folder="${f.id}" style="--fc:${f.color}">
        <i class="jbm-fi fa-solid ${sel ? "fa-folder-open" : "fa-folder"}"></i>
        <span class="jbm-nm">${esc(f.name)}</span>
        ${f.id === playingFolder ? `<i class="jbm-playing fa-solid fa-music" data-tooltip="Joue en ce moment"></i>` : ""}
        <span class="jbm-ct">${f.tracks.length}</span>
        <button type="button" class="jbm-ibtn jbm-sm jbm-fm" data-act="folder-menu" data-tooltip="Renommer, couleur, supprimer"><i class="fa-solid fa-ellipsis"></i></button>
      </div>`;
    }).join("") + `<div class="jbm-folder jbm-add-folder" data-act="new-folder"><i class="jbm-fi fa-solid fa-plus"></i><span class="jbm-nm">Nouveau dossier</span></div>`;
  },

  rows(L = readLibrary()) {
    const q = this.query.trim().toLowerCase();
    if (!q) return (this.folder(L)?.tracks ?? []).map(track => ({ track, folder: this.folder(L) }));
    const out = [];
    for (const folder of L.folders) for (const track of folder.tracks) if (track.title.toLowerCase().includes(q) || track.v.toLowerCase() === q) out.push({ track, folder });
    return out;
  },

  refreshTracks() {
    const root = this.root();
    if (!root) return;
    const L = readLibrary();
    const s = readChannel(ctlKey());
    const live = isLive(s);
    const general = ctlKey() === "target" && isLive(readState()) ? readState().track : null;
    const rows = this.rows(L);
    for (const k of this.picked) if (!findTrack(k, L)) this.picked.delete(k);
    const q = this.query.trim();
    const f = this.folder(L);
    let head;
    if (q) head = `<div class="jbm-thead"><h3>Recherche</h3><span class="jbm-sub">${plural(rows.length, "résultat", "résultats")} dans tous les dossiers</span></div>`;
    else if (f) {
      const total = f.tracks.reduce((a, t) => a + (t.dur || 0), 0);
      head = `<div class="jbm-thead" style="--fc:${f.color}"><h3><i class="fa-solid fa-folder-open"></i>${esc(f.name)}</h3>
        <span class="jbm-sub">${plural(f.tracks.length, "morceau", "morceaux")}${total ? ` · ${fmt(total)}` : ""}</span><span class="jbm-sp"></span>
        <button type="button" class="jbm-btn jbm-sm" data-act="play-folder"><i class="fa-solid fa-play"></i> Lancer le dossier</button></div>`;
    } else head = `<div class="jbm-thead"><h3>Aucun dossier</h3></div>`;
    const n = this.picked.size;
    const bar = n > 1 ? `<div class="jbm-selbar"><i class="fa-solid fa-check-double"></i> ${n} morceaux sélectionnés<span class="jbm-sp"></span>
      <button type="button" class="jbm-btn jbm-sm" data-act="sel-move"><i class="fa-solid fa-folder-tree"></i> Déplacer vers…</button>
      <button type="button" class="jbm-btn jbm-sm jbm-danger" data-act="sel-del"><i class="fa-solid fa-trash"></i> Supprimer</button>
      <button type="button" class="jbm-ibtn jbm-sm" data-act="sel-clear" data-tooltip="Tout désélectionner (Échap)"><i class="fa-solid fa-xmark"></i></button></div>` : "";
    const body = rows.length ? rows.map(({ track: t, folder }) => {
      const cur = live && t.k === s.track;
      return `<div class="jbm-track${cur ? " is-cur" : ""}${this.picked.has(t.k) ? " is-picked" : ""}" draggable="true" data-k="${t.k}" data-folder="${folder.id}">
        <i class="jbm-grip fa-solid fa-grip-vertical" data-tooltip="Glisser pour réordonner ou changer de dossier"></i>
        <span class="jbm-eq">${cur ? `<i class="fa-solid ${s.status === "play" ? "fa-volume-high" : "fa-pause"}"></i>`
          : t.k === general ? `<i class="fa-solid fa-users jbm-general" data-tooltip="Musique des autres joueurs (en boucle)"></i>` : ""}</span>
        <img class="jbm-thumb" src="${thumb(t.v)}" alt="" loading="lazy" draggable="false">
        <div class="jbm-t"><div class="jbm-n">${esc(t.title)}</div>${q ? `<div class="jbm-f"><span class="jbm-dot" style="--fc:${folder.color}"></span>${esc(folder.name)}</div>` : ""}</div>
        <span class="jbm-d">${t.dur ? fmt(t.dur) : ""}</span>
        <span class="jbm-acts">
          <button type="button" class="jbm-ibtn jbm-sm" data-act="play" data-tooltip="Lancer"><i class="fa-solid fa-play"></i></button>
          <button type="button" class="jbm-ibtn jbm-sm" data-act="move" data-tooltip="Déplacer vers un autre dossier"><i class="fa-solid fa-folder-tree"></i></button>
          <button type="button" class="jbm-ibtn jbm-sm jbm-del" data-act="del" data-tooltip="Supprimer"><i class="fa-solid fa-trash"></i></button>
          <button type="button" class="jbm-ibtn jbm-sm" data-act="track-menu" data-tooltip="Plus"><i class="fa-solid fa-ellipsis"></i></button>
        </span>
      </div>`;
    }).join("")
      : q ? `<div class="jbm-empty">Aucun morceau ne correspond.</div>`
      : `<div class="jbm-empty"><i class="fa-solid fa-folder-open"></i><br>Dossier vide. Glisse des morceaux ici depuis un autre dossier, ou utilise « Ajouter des musiques ».</div>`;
    const box = root.querySelector(".jbm-tracks");
    const scroll = box.scrollTop;
    box.innerHTML = head + bar + body;
    box.scrollTop = scroll;
  },

  refreshNow() {
    const root = this.root();
    if (!root) return;
    const s = readChannel(ctlKey());
    const live = isLive(s);
    const hit = live ? findTrack(s.track) : null;
    root.querySelector(".jbm-now-thumb").style.backgroundImage = live ? `url("${thumb(s.v, "mqdefault")}")` : "";
    root.querySelector(".jbm-now-title").textContent = live ? s.title || "—" : "Rien en cours";
    const state = !live ? "Arrêté" : Player.error ? "Lecture impossible" : s.status === "pause" ? "En pause" : "En lecture";
    const cls = !live || Player.error ? "is-off" : s.status === "pause" ? "is-paused" : "";
    root.querySelector(".jbm-now-lbl").innerHTML = `<span class="jbm-state ${cls}">${state}</span>`
      + (hit ? ` · <span class="jbm-dot" style="--fc:${hit.folder.color}"></span>${esc(hit.folder.name)}` : "");
    root.querySelector('[data-act="toggle"] i').className = `fa-solid fa-${live && s.status === "play" ? "pause" : "play"}`;
    for (const b of root.querySelectorAll(".jbm-seg [data-mode]")) b.classList.toggle("is-on", b.dataset.mode === s.mode);
    const range = root.querySelector(".jbm-vol-range");
    if (document.activeElement !== range) range.value = setting("volume");
    this.refreshProgress();
  },

  refreshProgress() {
    const root = this.root();
    if (!root) return;
    const s = readChannel(ctlKey());
    const live = isLive(s);
    const dur = live ? (findTrack(s.track)?.track.dur || (Player.video === s.v ? Player.duration : 0)) : 0;
    const pos = live ? Math.min(positionOf(s), dur || Infinity) : 0;
    root.querySelector(".jbm-t-cur").textContent = fmt(pos);
    root.querySelector(".jbm-t-dur").textContent = dur ? fmt(dur) : "–";
    root.querySelector(".jbm-bar span").style.width = dur ? `${(pos / dur) * 100}%` : "0";
  },

  refreshFoot() {
    const root = this.root();
    if (!root) return;
    const players = game.users.filter(u => u.active && !u.isGM);
    const targets = targetsOf(readTarget());
    root.querySelector(".jbm-foot").innerHTML = `<span><i class="fa-solid fa-headphones"></i> À l'écoute :</span>`
      + (players.length ? `<span class="jbm-who">${players.map(u => {
        const st = listeners.get(u.id);
        const aimed = !!targets?.includes(u.id);
        const cls = !st ? "is-unknown" : ["ok", "idle"].includes(st) ? "" : st === "blocked" || st === "error" ? "is-warn" : "is-off";
        const note = !st ? "pas de réponse" : LISTEN_LABELS[st];
        const tip = aimed ? "Entend le son ciblé" : !st ? "Le module ne répond pas chez ce joueur" : "";
        return `<span class="jbm-chip ${cls}"${tip ? ` data-tooltip="${tip}"` : ""}><i class="fa-solid ${aimed ? "fa-crosshairs" : "fa-circle"}"></i> ${esc(u.name)}${note ? ` · ${note}` : ""}</span>`;
      }).join("")}</span>` : `<span>aucun joueur connecté</span>`);
  },

  folderMenu(anchor, folderId) {
    const L = readLibrary();
    const f = findFolder(folderId, L);
    if (!f) return;
    const i = L.folders.indexOf(f);
    openMenu(anchor, `
      <div class="jbm-mh">${esc(f.name)}</div>
      <div class="jbm-mi${f.tracks.length ? "" : " is-off"}" data-m="play"><i class="fa-solid fa-play"></i>Lancer le dossier</div>
      <div class="jbm-mi" data-m="rename"><i class="fa-solid fa-pen"></i>Renommer</div>
      <div class="jbm-mi${i > 0 ? "" : " is-off"}" data-m="up"><i class="fa-solid fa-arrow-up"></i>Monter</div>
      <div class="jbm-mi${i < L.folders.length - 1 ? "" : " is-off"}" data-m="down"><i class="fa-solid fa-arrow-down"></i>Descendre</div>
      <div class="jbm-mh">Couleur</div>
      <div class="jbm-swatches">${COLORS.map(c => `<span class="jbm-sw${c === f.color ? " is-on" : ""}" data-m="color" data-c="${c}" style="background:${c}"></span>`).join("")}</div>
      <hr><div class="jbm-mi jbm-danger" data-m="delete"><i class="fa-solid fa-trash"></i>Supprimer le dossier${f.tracks.length ? ` (${plural(f.tracks.length, "morceau", "morceaux")})` : ""}</div>`,
      (m, el) => {
        if (m === "play") playFolder(folderId);
        if (m === "rename") renameFolder(folderId);
        if (m === "delete") deleteFolder(folderId);
        if (m === "color") editLibrary(L2 => { const x = findFolder(folderId, L2); if (!x) return false; x.color = el.dataset.c; });
        if (m === "up" || m === "down") editLibrary(L2 => {
          const a = L2.folders.findIndex(x => x.id === folderId), b = a + (m === "up" ? -1 : 1);
          if (a < 0 || b < 0 || b >= L2.folders.length) return false;
          [L2.folders[a], L2.folders[b]] = [L2.folders[b], L2.folders[a]];
        });
      });
  },

  moveMenu(anchor, keys) {
    const L = readLibrary();
    const here = keys.length === 1 ? findTrack(keys[0], L)?.folder.id : null;
    openMenu(anchor, `<div class="jbm-mh">Déplacer ${keys.length > 1 ? `${keys.length} morceaux ` : ""}vers</div>`
      + L.folders.map(f => `<div class="jbm-mi${f.id === here ? " is-off" : ""}" data-m="to" data-folder="${f.id}"><span class="jbm-dot" style="--fc:${f.color}"></span>${esc(f.name)}</div>`).join(""),
      (m, el) => {
        moveTracks(keys, el.dataset.folder);
        this.picked.clear();
      });
  },

  trackMenu(anchor, k) {
    const t = findTrack(k)?.track;
    if (!t) return;
    openMenu(anchor, `
      <div class="jbm-mi" data-m="play"><i class="fa-solid fa-play"></i>Lancer</div>
      <div class="jbm-mi" data-m="rename"><i class="fa-solid fa-pen"></i>Renommer</div>
      <div class="jbm-mi" data-m="move"><i class="fa-solid fa-folder-tree"></i>Déplacer vers…</div>
      <div class="jbm-mi" data-m="youtube"><i class="fa-brands fa-youtube"></i>Ouvrir sur YouTube</div><hr>
      <div class="jbm-mi jbm-danger" data-m="delete"><i class="fa-solid fa-trash"></i>Supprimer</div>`,
      m => {
        if (m === "play") playTrack(k);
        if (m === "rename") renameTrack(k);
        if (m === "move") setTimeout(() => this.moveMenu(anchor, [k]), 0);
        if (m === "youtube") window.open(`https://www.youtube.com/watch?v=${t.v}`, "_blank", "noopener");
        if (m === "delete") deleteTracks([k]);
      });
  },

  // Les morceaux concernés par une action sur une ligne : toute la sélection si la ligne en fait partie.
  targets(k) { return this.picked.has(k) && this.picked.size > 1 ? [...this.picked] : [k]; },

  onTrackClick(event, row) {
    const k = row.dataset.k;
    const list = this.rows().map(r => r.track.k);
    if (event.shiftKey && this.anchor && list.includes(this.anchor)) {
      if (!event.ctrlKey && !event.metaKey) this.picked.clear();
      const a = list.indexOf(this.anchor), b = list.indexOf(k);
      for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) this.picked.add(x);
    } else if (event.ctrlKey || event.metaKey) {
      this.picked.has(k) ? this.picked.delete(k) : this.picked.add(k);
      this.anchor = k;
    } else {
      this.picked.clear();
      this.picked.add(k);
      this.anchor = k;
    }
    this.refreshTracks();
    this.root()?.querySelector(".jbm-tracks").focus({ preventScroll: true });
  },

  wire(root) {
    root.addEventListener("click", event => {
      const t = event.target;
      const act = t.closest("[data-act]")?.dataset.act;
      const row = t.closest(".jbm-track");
      const folderEl = t.closest(".jbm-folder[data-folder]");
      const k = row?.dataset.k;
      switch (act) {
        case "toggle": return togglePlay();
        case "stop": return stopPlay();
        case "prev": return step(-1);
        case "next": return step(1);
        case "mode": return setMode(t.closest("[data-mode]").dataset.mode);
        case "add": return openAdd();
        case "back-all": return backToAll();
        case "aud-all":
          if (targetsOf(readTarget())) return backToAll();
          this.audience = [];
          return this.refreshAudience();
        case "aud-user": {
          const id = t.closest("[data-user]").dataset.user;
          this.audience = this.audience.includes(id) ? this.audience.filter(x => x !== id) : [...this.audience, id];
          return this.refreshAudience();
        }
        case "tools": return openMenu(t.closest("[data-act]"), `
          <div class="jbm-mi" data-m="export"><i class="fa-solid fa-file-export"></i>Exporter la bibliothèque</div>
          <div class="jbm-mi" data-m="import"><i class="fa-solid fa-file-import"></i>Importer un fichier</div>`,
          m => (m === "export" ? exportLibrary() : importLibrary()));
        case "new-folder": return createFolder();
        case "folder-menu": return this.folderMenu(t.closest("[data-act]"), folderEl.dataset.folder);
        case "play-folder": return playFolder(this.sel);
        case "sel-move": return this.moveMenu(t.closest("[data-act]"), [...this.picked]);
        case "sel-del": return deleteTracks([...this.picked]);
        case "sel-clear": this.picked.clear(); return this.refreshTracks();
        case "play": return playTrack(k);
        case "move": return this.moveMenu(t.closest("[data-act]"), this.targets(k));
        case "del": return deleteTracks(this.targets(k));
        case "track-menu": return this.trackMenu(t.closest("[data-act]"), k);
      }
      if (t.closest(".jbm-bar")) {
        const s = readChannel(ctlKey());
        const dur = findTrack(s.track)?.track.dur || (Player.video === s.v ? Player.duration : 0);
        const r = t.closest(".jbm-bar").getBoundingClientRect();
        if (dur) seek(((event.clientX - r.left) / r.width) * dur);
        return;
      }
      if (folderEl) return this.select(folderEl.dataset.folder);
      if (row) return this.onTrackClick(event, row);
    });
    root.addEventListener("dblclick", event => {
      const row = event.target.closest(".jbm-track");
      if (row && !event.target.closest(".jbm-acts")) playTrack(row.dataset.k);
    });
    root.addEventListener("contextmenu", event => {
      const row = event.target.closest(".jbm-track");
      const folderEl = event.target.closest(".jbm-folder[data-folder]");
      if (!row && !folderEl) return;
      event.preventDefault();
      if (row) this.trackMenu(event, row.dataset.k);
      else this.folderMenu(event, folderEl.dataset.folder);
    });
    // Suppr / Retour arrière ne doivent jamais atteindre Foundry d'ici (ils supprimeraient les jetons sélectionnés).
    root.addEventListener("keydown", event => {
      if (event.target.matches("input, textarea")) return;
      if (event.key === "Escape" && this.picked.size) { event.stopPropagation(); this.picked.clear(); this.refreshTracks(); }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.stopPropagation();
        event.preventDefault();
        if (this.picked.size) deleteTracks([...this.picked]);
      }
    });
    root.querySelector(".jbm-q").addEventListener("input", event => {
      this.query = event.target.value;
      this.picked.clear();
      this.refreshFolders();
      this.refreshTracks();
    });
    const range = root.querySelector(".jbm-vol-range");
    range.addEventListener("input", () => Player.call("setVolume", Number(range.value)));
    range.addEventListener("change", () => game.settings.set(ID, "volume", Number(range.value)));

    // Glisser-déposer : morceaux vers un dossier ou entre deux morceaux ; un lien YouTube lâché ouvre l'ajout.
    const isOurs = e => e.dataTransfer?.types.includes("application/x-jbm");
    const clearDrop = () => root.querySelectorAll(".is-drop, .is-dropline").forEach(el => el.classList.remove("is-drop", "is-dropline"));
    root.addEventListener("dragstart", event => {
      const row = event.target.closest?.(".jbm-track");
      if (!row) return;
      this.dragged = this.targets(row.dataset.k);
      event.dataTransfer.setData("application/x-jbm", this.dragged.join(","));
      event.dataTransfer.effectAllowed = "move";
      row.classList.add("is-dragging");
    });
    root.addEventListener("dragend", () => { root.querySelectorAll(".is-dragging").forEach(el => el.classList.remove("is-dragging")); clearDrop(); });
    root.addEventListener("dragover", event => {
      if (!isOurs(event)) {
        if (event.dataTransfer?.types.includes("text/uri-list") || event.dataTransfer?.types.includes("text/plain")) event.preventDefault();
        return;
      }
      const folderEl = event.target.closest(".jbm-folder[data-folder]");
      const row = !this.query && event.target.closest(".jbm-track");
      if (!folderEl && !row) return;
      event.preventDefault();
      clearDrop();
      (folderEl ?? row).classList.add(folderEl ? "is-drop" : "is-dropline");
    });
    root.addEventListener("drop", event => {
      if (!isOurs(event)) {
        const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
        if (/youtu\.?be/.test(text)) { event.preventDefault(); openAdd(text); }
        return;
      }
      event.preventDefault();
      clearDrop();
      const folderEl = event.target.closest(".jbm-folder[data-folder]");
      const row = !this.query && event.target.closest(".jbm-track");
      if (folderEl) moveTracks(this.dragged, folderEl.dataset.folder);
      else if (row) moveTracks(this.dragged, row.dataset.folder, row.dataset.k);
    });
  }
};

const SHELL = () => `
  <div class="jbm-lib">
    <div class="jbm-now">
      <div class="jbm-now-thumb"></div>
      <div class="jbm-now-meta">
        <div class="jbm-now-lbl"></div>
        <div class="jbm-now-title"></div>
        <div class="jbm-prog"><span class="jbm-t-cur">0:00</span><div class="jbm-bar" data-tooltip="Cliquer pour aller à ce moment"><span></span></div><span class="jbm-t-dur">–</span></div>
      </div>
      <div class="jbm-ctrls">
        <div class="jbm-ctrls-row">
          <button type="button" class="jbm-ibtn" data-act="prev" data-tooltip="Précédent"><i class="fa-solid fa-backward-step"></i></button>
          <button type="button" class="jbm-ibtn jbm-big" data-act="toggle" data-tooltip="Lecture / pause"><i class="fa-solid fa-play"></i></button>
          <button type="button" class="jbm-ibtn" data-act="stop" data-tooltip="Stop"><i class="fa-solid fa-stop"></i></button>
          <button type="button" class="jbm-ibtn" data-act="next" data-tooltip="Suivant"><i class="fa-solid fa-forward-step"></i></button>
          <span class="jbm-vsep"></span>
          <span class="jbm-vol" data-tooltip="Ton volume"><i class="fa-solid fa-volume-low"></i><input type="range" min="0" max="100" step="1" class="jbm-vol-range"></span>
        </div>
        <div class="jbm-seg">${Object.entries(MODES).map(([key, m]) => `<button type="button" data-act="mode" data-mode="${key}" data-tooltip="${esc(m.hint)}"><i class="fa-solid ${m.icon}"></i>${m.one ? `<span class="jbm-one">1</span>` : ""} ${m.label}</button>`).join("")}</div>
      </div>
    </div>
    <div class="jbm-target" hidden>
      <span class="jbm-target-txt"></span><span class="jbm-sp"></span>
      <button type="button" class="jbm-btn jbm-sm" data-act="back-all"><i class="fa-solid fa-users"></i> Revenir à tout le monde</button>
    </div>
    <div class="jbm-tools">
      <label class="jbm-search"><i class="fa-solid fa-magnifying-glass"></i><input type="text" class="jbm-q" placeholder="Chercher dans toute la bibliothèque…"></label>
      <button type="button" class="jbm-btn jbm-primary" data-act="add"><i class="fa-solid fa-plus"></i> Ajouter des musiques</button>
      <button type="button" class="jbm-ibtn" data-act="tools" data-tooltip="Exporter, importer"><i class="fa-solid fa-ellipsis-vertical"></i></button>
    </div>
    <div class="jbm-audience">
      <span class="jbm-aud-lbl" data-tooltip="Ce que tu lances n'est entendu que par les joueurs cochés ; les autres n'entendent rien"><i class="fa-solid fa-ear-listen"></i> Qui entend ?</span>
      <span class="jbm-aud-chips"></span>
      <span class="jbm-aud-hint"></span>
    </div>
    <div class="jbm-body">
      <div class="jbm-folders"></div>
      <div class="jbm-tracks" tabindex="0"></div>
    </div>
    <div class="jbm-foot"></div>
  </div>`;

class JukeboxApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    classes: ["jbm-app"],
    window: { title: "Jukebox", icon: "fa-solid fa-music", resizable: true },
    position: { width: 940, height: 660 }
  };

  async _renderHTML() { return SHELL(); }

  // Le contenu est construit une fois puis mis à jour par morceaux (le champ de recherche garde le focus).
  // Foundry appelle _replaceHTML avant d'enregistrer la fenêtre dans foundry.applications.instances :
  // Library garde donc sa propre référence au contenu.
  _replaceHTML(result, content) {
    if (!content.querySelector(".jbm-lib")) {
      content.innerHTML = result;
      Library.wire(content.querySelector(".jbm-lib"));
    }
    Library.el = content.querySelector(".jbm-lib");
    Library.refresh();
  }

  _onClose(options) {
    super._onClose(options);
    Library.el = null;
  }
}

function openLibrary() {
  if (!game.user.isGM) return;
  const app = foundry.applications.instances.get(APP_ID);
  if (app) app.bringToFront();
  else new JukeboxApp().render({ force: true });
}

function toggleLibrary() {
  const app = foundry.applications.instances.get(APP_ID);
  if (app) app.close();
  else openLibrary();
}

/* -------------------------------------------------- ajout par lot (MJ) */

const infoCache = new Map(); // id vidéo → { title, dur }

// Extrait les liens YouTube d'un texte quelconque. Un lien « vidéo dans une playlist » compte comme la vidéo.
function parseLinks(text) {
  const out = [], seen = new Set();
  for (const [raw] of String(text).matchAll(/https?:\/\/[^\s<>"']+/g)) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host !== "youtube.com" && host !== "youtu.be") { out.push({ kind: "bad", raw }); continue; }
    let v = host === "youtu.be" ? u.pathname.split("/")[1] : u.searchParams.get("v");
    if (!v && /^\/(shorts|live|embed)\//.test(u.pathname)) v = u.pathname.split("/")[2];
    const list = u.searchParams.get("list");
    if (v && /^[\w-]{11}$/.test(v)) {
      if (!seen.has(v)) { seen.add(v); out.push({ kind: "video", v }); }
    } else if (list) {
      if (!seen.has(list)) { seen.add(list); out.push({ kind: "playlist", list }); }
    } else out.push({ kind: "bad", raw });
  }
  return out;
}

const apiKey = () => String(setting("apiKey") || "").trim();
const isoDuration = iso => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
};

// Exécute fn sur les éléments, par paquets de `size` à la fois.
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// Titre d'une vidéo par l'oEmbed officiel de YouTube (sans clé). Réponse 404 : vidéo privée ou supprimée.
async function oembedTitle(v) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v}`)}`;
  try {
    const r = await fetch(url);
    return r.ok ? (await r.json()).title ?? null : null;
  } catch { return null; }
}

// Appel à l'API YouTube Data v3 avec la clé du réglage.
async function ytData(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.search = new URLSearchParams({ ...params, key: apiKey() });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`API YouTube ${endpoint} : ${r.status}`);
  return r.json();
}

// Titres (et durées avec une clé API) des vidéos pas encore connues.
async function fetchVideoInfo(ids) {
  const todo = [...new Set(ids)].filter(v => !infoCache.has(v));
  if (!todo.length) return;
  if (apiKey()) {
    for (let i = 0; i < todo.length; i += 50) {
      try {
        const j = await ytData("videos", { part: "snippet,contentDetails", id: todo.slice(i, i + 50).join(",") });
        for (const it of j.items ?? []) infoCache.set(it.id, { title: it.snippet?.title, dur: isoDuration(it.contentDetails?.duration) });
      } catch (err) { console.warn(`${ID} |`, err); }
    }
  }
  await inBatches(todo.filter(v => !infoCache.has(v)), 5, async v => infoCache.set(v, { title: await oembedTitle(v) }));
}

// Playlist sans clé : un lecteur hors écran prépare la playlist (cuePlaylist) et, une fois prête (état 5),
// donne la liste de ses vidéos (getPlaylist, 200 au plus). Abandon au bout de 15 s.
async function playlistFromPlayer(list) {
  try { await loadYouTubeAPI(); } catch { return []; }
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-10000px;top:0;width:200px;height:200px;pointer-events:none";
    const host = box.appendChild(document.createElement("div"));
    document.body.append(box);
    let probe = null, finished = false;
    const done = ids => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { probe?.destroy(); } catch {}
      box.remove();
      resolve(Array.isArray(ids) ? ids : []);
    };
    const timer = setTimeout(() => done([]), 15000);
    probe = new YT.Player(host, {
      width: 200,
      height: 200,
      playerVars: { origin: window.location.origin },
      events: {
        onReady: () => probe.cuePlaylist({ listType: "playlist", list }),
        onStateChange: e => {
          if (e.data !== 5) return;
          const ids = probe.getPlaylist();
          if (ids?.length) done(ids);
          else setTimeout(() => done(probe.getPlaylist()), 800);
        },
        onError: () => done([])
      }
    });
  });
}

async function fetchPlaylist(list) {
  let title = null, ids = [];
  if (apiKey()) {
    try {
      title = (await ytData("playlists", { part: "snippet", id: list })).items?.[0]?.snippet?.title ?? null;
      let pageToken = "";
      do {
        const j = await ytData("playlistItems", { part: "contentDetails", maxResults: "50", playlistId: list, ...(pageToken ? { pageToken } : {}) });
        ids.push(...(j.items ?? []).map(it => it.contentDetails?.videoId).filter(Boolean));
        pageToken = j.nextPageToken ?? "";
      } while (pageToken);
    } catch (err) { console.warn(`${ID} |`, err); }
  }
  if (!ids.length) ids = await playlistFromPlayer(list);
  await fetchVideoInfo(ids);
  return { title, ids };
}

class AddApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: ADD_ID,
    classes: ["jbm-app", "jbm-add-app"],
    window: { title: "Ajouter des musiques", icon: "fa-solid fa-plus", resizable: true },
    position: { width: 620, height: "auto" }
  };

  rows = [];        // { kind, v | list, title, dur, on, loading, items }
  timer = null;

  async _renderHTML() {
    return `<div class="jbm-add">
      <textarea class="jbm-paste" placeholder="Colle ici un ou plusieurs liens YouTube (vidéos ou playlists), un par ligne ou en vrac. Tu peux aussi glisser un lien depuis ton navigateur."></textarea>
      <div class="jbm-hint">Les titres sont récupérés automatiquement ; tu peux les corriger avant d'ajouter.</div>
      <div class="jbm-found"></div>
      <div class="jbm-dest">
        <span>Ranger dans</span>
        <select class="jbm-dest-sel"></select>
        <input type="text" class="jbm-dest-new" placeholder="Nom du nouveau dossier" hidden>
        <span class="jbm-sp"></span>
        <button type="button" class="jbm-btn jbm-primary jbm-confirm"><i class="fa-solid fa-check"></i> <span>Ajouter</span></button>
      </div>
    </div>`;
  }

  _replaceHTML(result, content) {
    if (content.querySelector(".jbm-add")) return;
    content.innerHTML = result;
    const root = content.querySelector(".jbm-add");
    const paste = root.querySelector(".jbm-paste");
    paste.addEventListener("input", () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.parse(), 350); });
    root.querySelector(".jbm-dest-sel").addEventListener("change", e => {
      const input = root.querySelector(".jbm-dest-new");
      input.hidden = e.target.value !== "new";
      if (!input.hidden) input.focus();
    });
    root.querySelector(".jbm-confirm").addEventListener("click", () => this.confirm());
    root.querySelector(".jbm-found").addEventListener("change", e => this.onCheck(e));
    root.querySelector(".jbm-found").addEventListener("input", e => {
      const row = this.rowFor(e.target);
      if (row && e.target.matches(".jbm-title-in")) row.title = e.target.value;
    });
    this.fillDest();
    this.renderRows();
  }

  get root() { return this.element?.querySelector(".jbm-add"); }

  appendText(text) {
    const paste = this.root?.querySelector(".jbm-paste");
    if (!paste || !text) return;
    paste.value += (paste.value && !paste.value.endsWith("\n") ? "\n" : "") + text.trim() + "\n";
    this.parse();
  }

  fillDest(prefer = null) {
    const sel = this.root?.querySelector(".jbm-dest-sel");
    if (!sel) return;
    const L = readLibrary();
    const keep = prefer ?? sel.value;
    sel.innerHTML = L.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("") + `<option value="new">＋ Nouveau dossier…</option>`;
    sel.value = keep && sel.querySelector(`option[value="${keep}"]`) ? keep : (Library.folder(L)?.id ?? "new");
    this.root.querySelector(".jbm-dest-new").hidden = sel.value !== "new";
  }

  // Relit les liens collés ; les lignes déjà connues gardent leurs titres corrigés et leurs cases.
  parse() {
    const links = parseLinks(this.root?.querySelector(".jbm-paste").value ?? "");
    const old = new Map(this.rows.map(r => [r.v ?? r.list ?? r.raw, r]));
    this.rows = links.map(l => old.get(l.v ?? l.list ?? l.raw) ?? { ...l, loading: l.kind !== "bad" });
    this.renderRows();
    for (const row of this.rows) if (row.loading && !row.fetching) this.load(row);
  }

  async load(row) {
    row.fetching = true;
    if (row.kind === "video") {
      const dupFolder = findVideo(row.v);
      if (!dupFolder) await fetchVideoInfo([row.v]);
      const info = infoCache.get(row.v) ?? {};
      const known = dupFolder?.tracks.find(t => t.v === row.v);
      row.title ??= known?.title ?? info.title ?? row.v;
      row.dur = known?.dur ?? info.dur;
      row.dup = dupFolder?.name ?? null;
      row.on = !row.dup;
    } else {
      const { title, ids } = await fetchPlaylist(row.list);
      row.title = title ?? "Playlist";
      row.items = ids.map(v => {
        const dup = findVideo(v)?.name ?? null;
        return { v, title: infoCache.get(v)?.title ?? v, dur: infoCache.get(v)?.dur, dup, on: !dup };
      });
      row.failed = !ids.length;
    }
    row.loading = false;
    this.renderRows();
  }

  rowFor(el) {
    const i = Number(el.closest("[data-i]")?.dataset.i);
    const row = this.rows[i];
    const j = el.closest("[data-j]")?.dataset.j;
    return j != null ? row?.items?.[Number(j)] : row;
  }

  onCheck(event) {
    const box = event.target;
    if (!box.matches('input[type="checkbox"]')) return;
    const row = this.rowFor(box);
    if (!row) return;
    if (box.dataset.all != null) { for (const it of row.items ?? []) it.on = box.checked; this.renderRows(); }
    else { row.on = box.checked; this.updateConfirm(); }
  }

  picked() {
    const out = [];
    for (const r of this.rows) {
      if (r.kind === "video" && !r.loading && r.on) out.push(r);
      if (r.kind === "playlist" && !r.loading) out.push(...(r.items ?? []).filter(it => it.on));
    }
    return out;
  }

  updateConfirm() {
    const btn = this.root?.querySelector(".jbm-confirm");
    if (!btn) return;
    const n = this.picked().length;
    btn.disabled = !n;
    btn.querySelector("span").textContent = n ? `Ajouter ${plural(n, "morceau", "morceaux")}` : "Ajouter";
  }

  renderRows() {
    const root = this.root;
    if (!root) return;
    const box = root.querySelector(".jbm-found");
    // Garde le focus si on était en train de corriger un titre.
    const active = document.activeElement?.matches?.(".jbm-title-in") ? document.activeElement : null;
    const focusKey = active ? `${active.closest("[data-i]")?.dataset.i}:${active.closest("[data-j]")?.dataset.j ?? ""}` : null;
    const caret = active?.selectionStart;
    const badge = r => r.dup ? `<span class="jbm-badge is-dup" data-tooltip="Déjà dans la bibliothèque">déjà dans « ${esc(r.dup)} »</span>`
      : r.dur ? `<span class="jbm-badge is-ok">${fmt(r.dur)}</span>` : "";
    const titleIn = r => `<input type="text" class="jbm-title-in" value="${esc(r.title)}">`;
    box.hidden = !this.rows.length;
    box.innerHTML = this.rows.map((r, i) => {
      if (r.kind === "bad") return `<div class="jbm-frow" data-i="${i}"><input type="checkbox" disabled><span class="jbm-n jbm-muted">${esc(r.raw)}</span><span class="jbm-badge is-bad">pas YouTube</span></div>`;
      if (r.loading) return `<div class="jbm-frow" data-i="${i}"><i class="fa-solid fa-spinner fa-spin"></i><span class="jbm-n jbm-muted">${r.kind === "playlist" ? "Lecture de la playlist…" : "Recherche du titre…"}</span></div>`;
      if (r.kind === "video") return `<div class="jbm-frow" data-i="${i}"><input type="checkbox"${r.on ? " checked" : ""}><img class="jbm-thumb" src="${thumb(r.v)}" alt=""><span class="jbm-n">${titleIn(r)}</span>${badge(r)}</div>`;
      if (r.failed) return `<div class="jbm-frow" data-i="${i}"><input type="checkbox" disabled><span class="jbm-n jbm-muted">Playlist illisible (privée ou introuvable)</span><span class="jbm-badge is-bad">playlist</span></div>`;
      const all = r.items.length && r.items.every(it => it.on);
      return `<div class="jbm-frow" data-i="${i}"><input type="checkbox" data-all${all ? " checked" : ""}><span class="jbm-plicon"><i class="fa-solid fa-list"></i></span><span class="jbm-n">${esc(r.title)}</span><span class="jbm-badge is-pl">playlist · ${plural(r.items.length, "morceau", "morceaux")}</span></div>`
        + r.items.map((it, j) => `<div class="jbm-frow jbm-sub" data-i="${i}" data-j="${j}"><input type="checkbox"${it.on ? " checked" : ""}><img class="jbm-thumb" src="${thumb(it.v)}" alt="" loading="lazy"><span class="jbm-n">${titleIn(it)}</span>${badge(it)}</div>`).join("");
    }).join("");
    if (focusKey) {
      const [i, j] = focusKey.split(":");
      const el = box.querySelector(`[data-i="${i}"]${j ? `[data-j="${j}"]` : ":not([data-j])"} .jbm-title-in`);
      if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch {} }
    }
    const n = this.rows.filter(r => r.kind !== "bad").length;
    root.querySelector(".jbm-hint").textContent = !this.rows.length ? "Les titres sont récupérés automatiquement ; tu peux les corriger avant d'ajouter."
      : `${plural(n, "lien YouTube repéré", "liens YouTube repérés")}${this.rows.length > n ? `, ${plural(this.rows.length - n, "lien ignoré", "liens ignorés")}` : ""}. Les doublons sont décochés.`;
    this.updateConfirm();
  }

  async confirm() {
    const items = this.picked();
    if (!items.length) return;
    const root = this.root;
    let folderId = root.querySelector(".jbm-dest-sel").value;
    const newName = root.querySelector(".jbm-dest-new").value.trim() || "Nouveau dossier";
    let name = "";
    await editLibrary(L => {
      let f = findFolder(folderId, L);
      if (!f) { f = makeFolder(newName, L); L.folders.push(f); folderId = f.id; }
      name = f.name;
      f.tracks.push(...items.map(makeTrack));
    });
    ui.notifications.info(`Jukebox : ${plural(items.length, "morceau ajouté", "morceaux ajoutés")} dans « ${name} ».`);
    root.querySelector(".jbm-paste").value = "";
    root.querySelector(".jbm-dest-new").value = "";
    this.rows = [];
    this.fillDest(folderId);
    this.renderRows();
    Library.select(folderId);
  }
}

function openAdd(text = "") {
  if (!game.user.isGM) return;
  const existing = foundry.applications.instances.get(ADD_ID);
  if (existing) {
    existing.bringToFront();
    existing.appendText(text);
    return;
  }
  const app = new AddApp();
  app.render({ force: true }).then(() => {
    app.appendText(text);
    app.root?.querySelector(".jbm-paste").focus();
  });
}

/* ------------------------------------------------------------------- hooks */

const applyTheme = () => document.body.classList.toggle("jbm-light", setting("theme") === "light");

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(ID, key, { config: false, ...data });
  reg("library", {
    scope: "world", type: Object, default: { folders: [] },
    onChange: () => {
      Library.refresh();
      foundry.applications.instances.get(ADD_ID)?.fillDest();
      Widget.update();
    }
  });
  reg("state", { scope: "world", type: Object, default: {}, onChange: () => { apply(); Library.refresh(); } });
  reg("target", { scope: "world", type: Object, default: {}, onChange: () => { apply(); Library.refresh(); } });
  reg("imported", { scope: "world", type: Boolean, default: false });
  reg("apiKey", {
    scope: "world", config: true, type: String, default: "",
    name: "Clé API YouTube (facultative)",
    hint: "Permet de récupérer les durées et les longues playlists à l'ajout. Sans elle, les titres viennent de YouTube (oEmbed) et la durée s'affiche après la première écoute."
  });
  reg("theme", {
    scope: "client", config: true, type: String, default: "dark",
    choices: { dark: "Sombre", light: "Clair" },
    name: "Thème du jukebox", hint: "Couleurs du widget et des fenêtres du jukebox sur cet ordinateur.",
    onChange: applyTheme
  });
  reg("volume", { scope: "client", type: Number, default: 40, onChange: () => { applyVolume(); Widget.update(); report(); } });
  reg("muted", { scope: "client", type: Boolean, default: false, onChange: () => { applyVolume(); Widget.update(); report(); } });
  // Vidéo masquée par défaut : le lecteur devient minuscule et YouTube choisit une qualité basse (moins de charge).
  reg("showVideo", { scope: "client", type: Boolean, default: false, onChange: () => Widget.update() });
  reg("minimized", { scope: "client", type: Boolean, default: false, onChange: () => Widget.update() });
  reg("widgetOpen", { scope: "client", type: Boolean, default: false, onChange: () => Widget.update() });
  reg("widgetPos", { scope: "client", type: Object, default: {} });

  game.keybindings.register(ID, "open", {
    name: "Ouvrir / fermer le jukebox",
    editable: [{ key: "KeyK", modifiers: ["Control"] }],
    restricted: true,
    onDown: () => { toggleLibrary(); return true; }
  });
});

Hooks.on("getSceneControlButtons", controls => {
  const group = controls.sounds ?? controls.notes;
  if (!group) return;
  group.tools[ID] = {
    name: ID,
    title: "Jukebox",
    icon: "fa-solid fa-music",
    order: Object.keys(group.tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => openLibrary()
  };
});

Hooks.on("userConnected", (user, connected) => {
  if (!connected) listeners.delete(user.id);
  Library.refreshAudience();
  Library.refreshFoot();
});

Hooks.once("ready", async () => {
  applyTheme();
  Widget.build();
  game.socket.on(SOCKET, onSocket);
  game.modules.get(ID).api = {
    open: openLibrary,
    add: openAdd,
    play: query => {
      const q = String(query ?? "").toLowerCase();
      const L = readLibrary();
      for (const f of L.folders) {
        const t = f.tracks.find(x => x.v === query || x.k === query) ?? f.tracks.find(x => x.title.toLowerCase().includes(q));
        if (t) return playTrack(t.k);
      }
      ui.notifications.warn(`Jukebox : aucun morceau ne correspond à « ${query} ».`);
    },
    playFolder: name => {
      const f = readLibrary().folders.find(x => x.name.toLowerCase() === String(name ?? "").toLowerCase());
      return f ? playFolder(f.id) : ui.notifications.warn(`Jukebox : aucun dossier « ${name} ».`);
    },
    toggle: togglePlay,
    stop: stopPlay,
    next: () => step(1),
    prev: () => step(-1)
  };

  if (isLeadGM()) {
    await migrate();
    for (const key of CHANNELS) {
      const s = readChannel(key);
      if (s.status !== "stop" && isStale(s)) await setChannel(key, { status: "stop", pos: 0, at: now(), targets: null });
    }
    // Restes de la 1.1.0 (son ciblé rangé dans « state ») : nettoyés.
    if (readState().targets || readState().saved) await setState({ targets: null, saved: null });
  }
  Library.audience = [...(targetsOf(readTarget()) ?? [])];
  apply();
  if (game.user.isGM) game.socket.emit(SOCKET, { type: "ping" });

  let ticks = 0;
  setInterval(() => {
    Library.refreshProgress();
    if (++ticks % 6 === 0) correctDrift();
  }, 500);
});
