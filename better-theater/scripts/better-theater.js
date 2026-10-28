// Better Theater : les portraits des personnages flottent en ronde ovale autour de l'écran (remplace « Add to Stage »).
// Seul le MJ actif écrit, dans le réglage du monde « stage » ; les joueurs lui envoient leurs demandes par socket
// (ajouter leur personnage, émotion, miroir, retirer) et il vérifie qu'ils en ont le droit.
// La ronde est calculée par chaque client d'après son propre écran : même ordre pour tous, pas les mêmes pixels.
// Les portraits laissent passer les clics, sauf pour leur propriétaire (et le MJ) qui ouvre ainsi leur menu.
// Main levée (à la Google Meet) : un joueur demande la parole par Alt+L ou le menu de son portrait ; la file d'attente
// est dans le même réglage, badge sur le portrait et dans la liste des joueurs, le MJ donne la parole ou baisse.

const ID = "better-theater";
const SOCKET = `module.${ID}`;
const EMOTES = ["😄", "😏", "😮", "🤔", "😢", "😠", "😨", "❤️"];
const GAP = 14;                 // écart minimal entre deux portraits (px)
const MIN_OPEN = 20;            // demi-ouverture minimale en bas de la ronde (degrés)
const MAX_OPEN = 80;            // au-delà, on n'ouvre plus : les portraits se rapprochent
const BUBBLE_MS = 5000;
const FLOOR_MS = 4000;          // « parle » du portrait à qui le MJ donne la parole
const FALLBACK_IMG = "icons/svg/mystery-man.svg";

/* ----------------------------------------------------------------- outils */

const setting = key => game.settings.get(ID, key);
const isLeadGM = () => !!game.users.activeGM?.isSelf;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Écritures à la file, pour que deux demandes rapprochées ne s'écrasent pas.
function queue() {
  let chain = Promise.resolve();
  return fn => (chain = chain.then(fn).catch(err => console.error(`${ID} |`, err)));
}
const writeQueue = queue();

function readStage() {
  const s = game.settings.get(ID, "stage") ?? {};
  return {
    entries: Array.isArray(s.entries) ? s.entries : [],
    focus: s.focus ?? null,
    curtain: !!s.curtain,
    hands: Array.isArray(s.hands) ? s.hands : []
  };
}

const actorOf = entry => (entry?.actorId ? game.actors.get(entry.actorId) : null);

// Joueur attitré d'un personnage : celui dont c'est le personnage, sinon le premier joueur propriétaire.
function playerOf(actor) {
  if (!actor) return null;
  return game.users.find(u => !u.isGM && u.character?.id === actor.id)
    ?? game.users.find(u => !u.isGM && actor.testUserPermission(u, "OWNER"))
    ?? null;
}

function canEdit(user, entry) {
  if (!entry || !user) return false;
  if (user.isGM) return true;
  return !!actorOf(entry)?.testUserPermission(user, "OWNER");
}

// Ce qu'on affiche pour une entrée. L'image et le nom suivent la fiche en direct ; le portrait réglé dans
// Theatre Inserts (flags.theatre.baseinsert) est repris s'il existe. Lecture directe des flags : getFlag
// refuserait la portée « theatre » si le module est désactivé.
function describe(entry) {
  const actor = actorOf(entry);
  if (entry.actorId && !actor) return null;
  const player = playerOf(actor);
  return {
    ...entry,
    img: entry.img || actor?.flags?.[ID]?.portrait || actor?.flags?.theatre?.baseinsert || actor?.img || FALLBACK_IMG,
    name: entry.name || actor?.flags?.theatre?.name || actor?.name || "?",
    pc: !!actor?.hasPlayerOwner,
    color: player ? String(player.color?.css ?? player.color) : null
  };
}

/* ------------------------------------------------------------ mains levées */

// La main appartient au joueur, pas au personnage : elle se lève même sans portrait sur scène (Alt+L ou
// le menu du portrait, volontairement pas de bouton près du chat). On retient le portrait d'où elle a été levée.
const handOf = (userId, stage = readStage()) => stage.hands.find(h => h.userId === userId) ?? null;

// Portrait qui porte le badge : celui d'où la main a été levée, sinon le personnage attitré du joueur, sinon le
// premier de ses personnages sur scène.
function handEntry(hand, entries) {
  const user = game.users.get(hand.userId);
  if (!user) return null;
  const owned = e => !!actorOf(e)?.testUserPermission(user, "OWNER");
  return entries.find(e => e.id === hand.entryId && owned(e))
    ?? entries.find(e => e.actorId && e.actorId === user.character?.id)
    ?? entries.find(owned)
    ?? null;
}

const ordinal = n => `${n}${n === 1 ? "ʳᵉ" : "ᵉ"}`;

function handKey() {
  const binding = game.keybindings.get(ID, "hand")?.[0];
  return binding ? foundry.applications.sidebar.apps.ControlsConfig.humanizeBinding(binding) : "";
}

// Lève ou baisse ma main (raccourci, menu du portrait).
function toggleHand(entryId = null) {
  if (game.user.isGM) return;
  if (handOf(game.user.id)) request("lowerHand", { userId: game.user.id });
  else request("raiseHand", { entryId });
}

// Le MJ donne la parole : la main se baisse, le portrait « parle » chez tout le monde et le joueur est prévenu.
function giveFloor(userId) {
  const stage = readStage();
  const hand = handOf(userId, stage);
  if (!game.user.isGM || !hand) return;
  const msg = { type: "floor", userId, entryId: handEntry(hand, stage.entries)?.id ?? null };
  request("lowerHand", { userId });
  onFloor(msg);
  game.socket.emit(SOCKET, msg);
}

function onFloor({ userId, entryId }) {
  if (entryId) Stage.speak(entryId, FLOOR_MS);
  if (userId === game.user.id) ui.notifications.info("Better Theater : le MJ vous donne la parole.");
}

// Son chez le MJ quand une main se lève (pas au chargement : on part des mains déjà levées).
let knownHands = new Set();
function onHandsChanged() {
  const now = new Set(readStage().hands.map(h => h.userId));
  const raised = [...now].some(id => !knownHands.has(id));
  knownHands = now;
  if (raised && game.user.isGM && setting("handSound")) {
    foundry.audio.AudioHelper.play({ src: CONFIG.sounds.notification, volume: 0.6 }, false);
  }
  decoratePlayers();
}

// Liste des joueurs (en bas à gauche) : la main s'y voit toujours, même sans portrait, théâtre masqué ou rideau
// baissé. Clic : le joueur baisse sa main, le MJ choisit entre donner la parole et baisser.
function decoratePlayers() {
  const root = document.getElementById("players");
  if (!root) return;
  const hands = readStage().hands;
  for (const li of root.querySelectorAll("li.player[data-user-id]")) {
    const userId = li.dataset.userId;
    const rank = hands.findIndex(h => h.userId === userId) + 1;
    let tag = li.querySelector(".bt-hand-tag");
    if (!rank) {
      tag?.remove();
      continue;
    }
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "bt-hand-tag";
      tag.innerHTML = `<i class="fa-solid fa-hand"></i><b></b>`;
      tag.addEventListener("click", event => {
        event.stopPropagation();
        if (userId === game.user.id) request("lowerHand", { userId });
        else if (game.user.isGM) Panel.toggle(tag, "hand", userId);
      });
      li.append(tag);
    }
    const mine = userId === game.user.id, can = mine || game.user.isGM;
    tag.querySelector("b").textContent = rank;
    tag.classList.toggle("bt-can", can);
    tag.dataset.tooltip = `Main levée (${ordinal(rank)})`
      + (mine ? " : cliquer pour la baisser" : can ? " : donner la parole ou baisser" : "");
  }
}

/* ------------------------------------------------- demandes et écritures */

// Chaque action reçoit une copie de l'état, la modifie et dit si elle a changé quelque chose.
const ACTIONS = {
  addActor(s, { actorId }, user) {
    const actor = game.actors.get(actorId);
    if (!actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
    if (s.entries.some(e => e.actorId === actorId)) return false;
    s.entries.push({ id: foundry.utils.randomID(), actorId, emote: null, mirror: false });
    return true;
  },
  removeActor(s, { actorId }, user) {
    const entry = s.entries.find(e => e.actorId === actorId);
    return entry ? ACTIONS.remove(s, { id: entry.id }, user) : false;
  },
  addImage(s, { img, name }, user) {
    if (!user.isGM || !img) return false;
    s.entries.push({ id: foundry.utils.randomID(), img: String(img), name: String(name ?? "").slice(0, 60) || null, emote: null, mirror: false });
    return true;
  },
  emote(s, { id, emote }, user) {
    const entry = s.entries.find(e => e.id === id);
    if (!canEdit(user, entry)) return false;
    entry.emote = EMOTES.includes(emote) && entry.emote !== emote ? emote : null;
    return true;
  },
  mirror(s, { id }, user) {
    const entry = s.entries.find(e => e.id === id);
    if (!canEdit(user, entry)) return false;
    entry.mirror = !entry.mirror;
    return true;
  },
  remove(s, { id }, user) {
    const entry = s.entries.find(e => e.id === id);
    if (!canEdit(user, entry)) return false;
    s.entries = s.entries.filter(e => e.id !== id);
    if (s.focus === id) s.focus = null;
    return true;
  },
  focus(s, { id }, user) {
    if (!user.isGM) return false;
    s.focus = s.focus === id ? null : id;
    return true;
  },
  rename(s, { id, name }, user) {
    const entry = s.entries.find(e => e.id === id);
    if (!user.isGM || !entry) return false;
    entry.name = String(name ?? "").trim().slice(0, 60) || null;
    return true;
  },
  curtain(s, _data, user) {
    if (!user.isGM) return false;
    s.curtain = !s.curtain;
    return true;
  },
  clear(s, _data, user) {
    if (!user.isGM) return false;
    s.entries = [];
    s.focus = null;
    return true;
  },
  // Mains levées : chacun lève la sienne (pas le MJ) ; le joueur baisse la sienne, le MJ n'importe laquelle.
  raiseHand(s, { entryId }, user) {
    if (user.isGM || s.hands.some(h => h.userId === user.id)) return false;
    const entry = s.entries.find(e => e.id === entryId);
    s.hands.push({ userId: user.id, entryId: entry && canEdit(user, entry) ? entry.id : null });
    return true;
  },
  lowerHand(s, { userId }, user) {
    if (!user.isGM && userId !== user.id) return false;
    const before = s.hands.length;
    s.hands = s.hands.filter(h => h.userId !== userId);
    return s.hands.length !== before;
  },
  lowerAll(s, _data, user) {
    if (!user.isGM || !s.hands.length) return false;
    s.hands = [];
    return true;
  },
  // Ménage du MJ : entrées dont le personnage a été supprimé, mains des joueurs partis.
  prune(s, _data, user) {
    if (!user.isGM) return false;
    const before = s.entries.length + s.hands.length;
    s.entries = s.entries.filter(e => !e.actorId || game.actors.has(e.actorId));
    if (s.focus && !s.entries.some(e => e.id === s.focus)) s.focus = null;
    s.hands = s.hands.filter(h => game.users.get(h.userId)?.active);
    return s.entries.length + s.hands.length !== before;
  }
};

function run(action, data, user) {
  const fn = ACTIONS[action];
  if (!fn || !user) return;
  return writeQueue(async () => {
    const s = foundry.utils.deepClone(readStage());
    if (fn(s, data ?? {}, user)) await game.settings.set(ID, "stage", s);
  });
}

function request(action, data = {}) {
  if (isLeadGM()) return run(action, data, game.user);
  if (!game.users.activeGM) {
    ui.notifications.warn("Better Theater : le MJ doit être connecté pour modifier le théâtre.");
    return;
  }
  game.socket.emit(SOCKET, { type: "request", action, data, userId: game.user.id });
}

function onSocket(msg) {
  if (msg?.type === "request" && isLeadGM()) run(msg.action, msg.data, game.users.get(msg.userId));
  else if (msg?.type === "speak") Stage.speak(msg.id, msg.ms);
  else if (msg?.type === "floor") onFloor(msg);
}

const isStaged = actor => !!actor && readStage().entries.some(e => e.actorId === actor.id);
const toggleActor = actor => request(isStaged(actor) ? "removeActor" : "addActor", { actorId: actor.id });

function pickImage() {
  const FP = foundry.applications.apps.FilePicker.implementation;
  new FP({
    type: "image",
    callback: path => {
      const file = decodeURIComponent(path.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
      const name = file.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      request("addImage", { img: path, name: name ? name[0].toUpperCase() + name.slice(1) : "" });
    }
  }).render({ force: true });
}

async function promptRename(entry) {
  const value = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Nom affiché dans le théâtre" },
    content: `<input type="text" name="name" value="${esc(entry.name)}" placeholder="Vide = nom de la fiche" autofocus>`,
    ok: { label: "Renommer", callback: (_event, button) => button.form.elements.name.value },
    rejectClose: false
  });
  if (value !== null && value !== undefined) request("rename", { id: entry.id, name: value });
}

/* -------------------------------------------------------------- miniatures */

// Les images des fiches font parfois 4000 px : affichées telles quelles, le navigateur garderait toute l'image en
// mémoire (~70 Mo). On en tire une fois une miniature et on ne garde qu'elle. En cas d'échec (image d'un autre site
// sans autorisation, SVG…), on affiche l'image d'origine.
const THUMB_PX = 512;
const thumbs = new Map();

function thumbnail(src) {
  if (!thumbs.has(src)) thumbs.set(src, makeThumbnail(src).catch(() => src));
  return thumbs.get(src);
}

function makeThumbnail(src) {
  if (/\.svg(\?|$)/i.test(src) || src.startsWith("data:image/svg")) return Promise.resolve(src);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onerror = reject;
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const k = THUMB_PX / Math.max(w, h);
      if (!w || !h || k >= 0.75) return resolve(src);   // déjà petite : rien à gagner
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => (blob ? resolve(URL.createObjectURL(blob)) : reject()), "image/webp", 0.9);
    };
    img.src = src;
  });
}

/* ------------------------------------------------------- tracé de la ronde */

function visibleRect(el) {
  if (!el || !el.isConnected || el.hidden || el.offsetParent === null) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

// Zone libre : entre les outils de gauche et la barre latérale. Obstacles du bas : barre d'action, liste des
// joueurs, saisie du chat quand la barre latérale est repliée.
function measure(origin) {
  const W = window.innerWidth, H = window.innerHeight;
  const ctrl = visibleRect(document.getElementById("scene-controls"));
  const side = visibleRect(document.getElementById("sidebar"));
  const area = {
    x0: (ctrl ? ctrl.right : 0) + 10 - origin.left,
    x1: (side ? side.left : W) - 10 - origin.left,
    y0: 6 - origin.top,
    y1: H - 6 - origin.top
  };
  const obstacles = ["hotbar", "players", "chat-message", "chat-controls"]
    .map(id => visibleRect(document.getElementById(id)))
    .filter(r => r && r.top > H * 0.45)
    .map(r => ({ left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top }));
  return { area, obstacles };
}

// Ovale ouvert en bas : angle t mesuré depuis le haut, sens horaire, de -T à +T.
function buildPath(area, s, openDeg) {
  const cx = (area.x0 + area.x1) / 2;
  const cy = (area.y0 + area.y1) / 2;
  const a = Math.max(40, (area.x1 - area.x0) / 2 - s * 0.5);
  const b = Math.max(40, (area.y1 - area.y0) / 2 - s * 0.6);
  const T = (180 - openDeg) * Math.PI / 180;
  const N = 400, pts = [], len = [0];
  for (let i = 0; i <= N; i++) {
    const t = -T + (2 * T * i) / N;
    pts.push({ x: cx + a * Math.sin(t), y: cy - b * Math.cos(t) });
    if (i) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, len, L: len[N], cx, cy };
}

function pointAt(path, d) {
  const { pts, len } = path;
  d = clamp(d, 0, path.L);
  let lo = 0, hi = len.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (len[m] < d) lo = m; else hi = m;
  }
  const f = (d - len[lo]) / ((len[hi] - len[lo]) || 1);
  return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * f, y: pts[lo].y + (pts[hi].y - pts[lo].y) * f };
}

const hits = (box, obstacles) => obstacles.some(o => box.left < o.right && box.right > o.left && box.top < o.bottom && box.bottom > o.top);

// On ouvre le bas de la ronde jusqu'à ce que les portraits des deux extrémités ne touchent plus d'obstacle.
function fitPath(area, obstacles, s) {
  const w = s, h = s * 1.15;
  let path;
  for (let open = MIN_OPEN; open <= MAX_OPEN; open += 3) {
    path = buildPath(area, s, open);
    const ends = [path.pts[0], path.pts[path.pts.length - 1]]
      .map(p => ({ left: p.x - w / 2, right: p.x + w / 2, top: p.y - h / 2, bottom: p.y + h / 2 }));
    if (!ends.some(box => hits(box, obstacles))) break;
  }
  return path;
}

/* ------------------------------------------------------------------ scène */

const Stage = {
  root: null,
  nodes: new Map(),
  layout: new Map(),
  path: null,
  menu: null,
  menuFor: null,
  overflow: null,
  frame: 0,

  build() {
    this.root?.remove();
    this.root = document.createElement("div");
    this.root.id = "bt-stage";
    (document.getElementById("interface") ?? document.body).prepend(this.root);
    this.render();
  },

  // Rendu regroupé à la prochaine image (plusieurs hooks peuvent tomber en même temps).
  render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  },

  ordered() {
    const stage = readStage();
    const all = stage.entries.map(describe).filter(Boolean);
    const pcs = all.filter(e => e.pc);
    let others = all.filter(e => !e.pc);
    const room = Math.max(0, setting("max") - pcs.length);
    const hidden = others.slice(0, Math.max(0, others.length - room));
    others = others.slice(hidden.length);   // les plus anciennes images se rangent dans « +N »
    const left = pcs.filter((_, i) => i % 2 === 0).reverse();
    const right = pcs.filter((_, i) => i % 2 === 1);
    return { list: [...left, ...others, ...right], hidden, stage };
  },

  draw() {
    if (!this.root) return;
    const { list, hidden, stage } = this.ordered();
    // Masqué chez moi : invisible. Rideau : invisible chez les joueurs, en transparence chez le MJ.
    this.root.classList.toggle("bt-hidden", !!setting("hidden"));
    this.root.classList.toggle("bt-curtain", stage.curtain);
    this.root.classList.toggle("bt-gm", game.user.isGM);
    // Qualité graphique « basse » dans Foundry : pas de flottement.
    this.root.classList.toggle("bt-calm", game.settings.get("core", "performanceMode") === CONST.CANVAS_PERFORMANCE_MODES.LOW);

    const origin = this.root.getBoundingClientRect();
    const { area, obstacles } = measure(origin);
    const n = list.length;
    const base = clamp(window.innerHeight * 0.15, 90, 170) * setting("scale");
    let s = base * clamp(1 - (n - 4) * 0.045, 0.64, 1);
    let path = fitPath(area, obstacles, s);
    if (n * (s + GAP) > path.L) {
      s = Math.max(base * 0.45, path.L / n - GAP);
      path = fitPath(area, obstacles, s);
    }
    this.path = path;
    // Écart : la ronde s'étale au fil des arrivées, centrée sur le haut de l'écran.
    const step = Math.min(path.L / Math.max(n, 1), Math.max(s + GAP, path.L / (n + 2.5)));
    const mid = path.L / 2;

    // Badge de main levée : un par portrait, numéro = place dans la file.
    const hands = new Map();
    stage.hands.forEach((hand, i) => {
      const entry = handEntry(hand, list);
      if (entry && !hands.has(entry.id)) hands.set(entry.id, { userId: hand.userId, rank: i + 1 });
    });

    const seen = new Set();
    this.layout = new Map();
    list.forEach((entry, i) => {
      seen.add(entry.id);
      const size = stage.focus === entry.id ? s * 1.35 : s;
      const pos = pointAt(path, mid + (i - (n - 1) / 2) * step);
      const box = { x: pos.x, y: pos.y, w: size, h: size * 1.15 };
      this.layout.set(entry.id, box);
      let el = this.nodes.get(entry.id);
      if (!el) {
        el = this.createNode(entry);
        // Entrée : part du centre de l'écran, comme un esprit qui rejoint la ronde.
        this.place(el, { x: path.cx, y: path.cy, w: box.w, h: box.h });
        void el.offsetWidth;
        el.classList.remove("bt-enter");
      }
      this.updateNode(el, entry, stage, hands.get(entry.id));
      this.place(el, box);
    });

    for (const [id, el] of this.nodes) {
      if (seen.has(id)) continue;
      this.nodes.delete(id);
      el.classList.add("bt-leave");
      setTimeout(() => el.remove(), 450);
    }
    if (this.menuFor && !seen.has(this.menuFor)) this.closeMenu();

    if (hidden.length) {
      if (!this.overflow) {
        this.overflow = document.createElement("div");
        this.overflow.className = "bt-overflow";
        this.root.append(this.overflow);
      }
      const pos = pointAt(path, mid + (-(n - 1) / 2 - 0.8) * step);
      this.overflow.style.left = `${pos.x}px`;
      this.overflow.style.top = `${pos.y}px`;
      this.overflow.textContent = `+${hidden.length}`;
      this.overflow.dataset.tooltip = `Rangé${hidden.length > 1 ? "s" : ""} : ${hidden.map(e => esc(e.name)).join(", ")}`;
    } else {
      this.overflow?.remove();
      this.overflow = null;
    }

    if (this.menuFor) this.positionMenu();
  },

  createNode(entry) {
    const el = document.createElement("div");
    el.className = "bt-pt bt-enter";
    el.dataset.id = entry.id;
    el.innerHTML = `<div class="bt-float"><div class="bt-bust"><img alt="" draggable="false"></div><div class="bt-name"></div></div>`;
    const float = el.querySelector(".bt-float");
    float.style.setProperty("--bt-dur", `${(4.2 + Math.random() * 2).toFixed(2)}s`);
    float.style.setProperty("--bt-delay", `${(-Math.random() * 5).toFixed(2)}s`);
    el.addEventListener("click", event => {
      event.stopPropagation();
      this.openMenu(el.dataset.id);
    });
    this.root.append(el);
    this.nodes.set(entry.id, el);
    return el;
  },

  updateNode(el, entry, stage, hand) {
    const img = el.querySelector("img");
    if (el.dataset.src !== entry.img) {
      el.dataset.src = entry.img;
      thumbnail(entry.img).then(url => { if (el.dataset.src === entry.img) img.src = url; });
    }
    el.querySelector(".bt-name").textContent = entry.name;
    el.classList.toggle("bt-pc", entry.pc);
    el.classList.toggle("bt-mirror", !!entry.mirror);
    el.classList.toggle("bt-focus", stage.focus === entry.id);
    el.classList.toggle("bt-can", canEdit(game.user, entry));
    if (entry.color) el.style.setProperty("--bt-aura", entry.color);
    else el.style.removeProperty("--bt-aura");
    let badge = el.querySelector(".bt-emote");
    if (entry.emote) {
      if (badge?.textContent !== entry.emote) {
        badge?.remove();
        badge = document.createElement("div");
        badge.className = "bt-emote";
        badge.textContent = entry.emote;
        el.querySelector(".bt-float").append(badge);
      }
    } else badge?.remove();
    let raised = el.querySelector(".bt-hand");
    if (hand) {
      if (!raised) {
        raised = document.createElement("div");
        raised.className = "bt-hand";
        raised.innerHTML = `<i class="fa-solid fa-hand"></i><b></b>`;
        // Ma propre main : un clic la baisse sans ouvrir le menu. Sinon (MJ), le clic ouvre le menu du portrait.
        raised.addEventListener("click", event => {
          if (raised.dataset.user !== game.user.id) return;
          event.stopPropagation();
          request("lowerHand", { userId: game.user.id });
        });
        el.querySelector(".bt-float").append(raised);
      }
      raised.dataset.user = hand.userId;
      raised.querySelector("b").textContent = hand.rank;
      raised.dataset.tooltip = hand.userId === game.user.id ? "Baisser la main" : `Main levée (${ordinal(hand.rank)})`;
    } else raised?.remove();
  },

  place(el, box) {
    el.style.left = `${box.x - box.w / 2}px`;
    el.style.top = `${box.y - box.h / 2}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
  },

  /* ----- menu du portrait ----- */

  openMenu(id) {
    const entry = describe(readStage().entries.find(e => e.id === id) ?? {});
    if (!entry || !canEdit(game.user, entry)) return;
    if (this.menuFor === id) return this.closeMenu();
    this.closeMenu();
    this.menuFor = id;
    const gm = game.user.isGM;
    const btn = (act, icon, tip, on = false, extra = "") =>
      `<button type="button" data-act="${act}" ${extra} class="${on ? "bt-on" : ""}" data-tooltip="${tip}" aria-label="${tip}">${icon}</button>`;
    const emotes = EMOTES.map(e => btn("emote", e, "Émotion", entry.emote === e, `data-emote="${e}"`)).join("");
    const stage = readStage();
    // Main : le joueur lève / baisse la sienne ; le MJ, si une main est levée sur ce portrait, donne la parole ou baisse.
    const key = handKey();
    const mine = handOf(game.user.id, stage);
    const here = stage.hands.find(h => handEntry(h, stage.entries)?.id === id);
    const hand = gm
      ? (here ? btn("floor", `<i class="fa-solid fa-microphone"></i>`, `Donner la parole à ${esc(game.users.get(here.userId)?.name)}`)
        + btn("lower", `<i class="fa-solid fa-hand-back-fist"></i>`, "Baisser la main") : "")
      : btn("hand", `<i class="fa-solid fa-hand"></i>`, `${mine ? "Baisser" : "Lever"} la main${key ? ` (${key})` : ""}`, !!mine);
    this.menu = document.createElement("div");
    this.menu.className = "bt-menu";
    this.menu.innerHTML = `<div class="bt-row">${emotes}</div><div class="bt-row">`
      + hand
      + btn("mirror", `<i class="fa-solid fa-arrows-left-right"></i>`, "Miroir", entry.mirror)
      + (gm ? btn("focus", `<i class="fa-solid fa-star"></i>`, "Mettre en avant", stage.focus === id) : "")
      + (gm ? btn("rename", `<i class="fa-solid fa-signature"></i>`, "Renommer") : "")
      + (entry.actorId ? btn("sheet", `<i class="fa-solid fa-id-card"></i>`, "Ouvrir la fiche") : "")
      + btn("remove", `<i class="fa-solid fa-xmark"></i>`, "Retirer du théâtre", false, `data-danger`)
      + `</div>`;
    this.menu.addEventListener("click", event => {
      event.stopPropagation();
      const b = event.target.closest("button[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "emote") request("emote", { id, emote: b.dataset.emote });
      else if (act === "mirror") request("mirror", { id });
      else if (act === "focus") request("focus", { id });
      else if (act === "rename") { this.closeMenu(); promptRename(entry); return; }
      else if (act === "sheet") { this.closeMenu(); actorOf(entry)?.sheet?.render(true); return; }
      else if (act === "remove") { this.closeMenu(); request("remove", { id }); return; }
      else if (act === "hand") { this.closeMenu(); toggleHand(id); return; }
      else if (act === "floor") { this.closeMenu(); giveFloor(here.userId); return; }
      else if (act === "lower") { this.closeMenu(); request("lowerHand", { userId: here.userId }); return; }
      if (act === "emote" || act === "mirror" || act === "focus") b.classList.toggle("bt-on");
      if (act === "emote") this.menu.querySelectorAll('[data-act="emote"]').forEach(x => x !== b && x.classList.remove("bt-on"));
    });
    this.root.append(this.menu);
    this.positionMenu();
  },

  positionMenu() {
    const box = this.layout.get(this.menuFor);
    if (!box || !this.menu) return;
    const mw = this.menu.offsetWidth, mh = this.menu.offsetHeight;
    const below = box.y < window.innerHeight / 2;
    const x = clamp(box.x - mw / 2, 8, window.innerWidth - mw - 8);
    const y = below ? box.y + box.h / 2 + 8 : box.y - box.h / 2 - mh - 8;
    this.menu.style.left = `${x}px`;
    this.menu.style.top = `${clamp(y, 8, window.innerHeight - mh - 8)}px`;
  },

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
    this.menuFor = null;
  },

  /* ----- parole et bulles ----- */

  // État « parle » (halo + petit sursaut). Point d'entrée de la future voix Discord.
  speak(id, ms = 1500) {
    const el = this.nodes.get(id);
    if (!el) return;
    el.classList.add("bt-speak");
    clearTimeout(el._btSpeak);
    el._btSpeak = setTimeout(() => el.classList.remove("bt-speak"), ms);
  },

  say(id, text, { emote = false } = {}) {
    const box = this.layout.get(id);
    const el = this.nodes.get(id);
    if (!box || !el || !this.path) return;
    this.speak(id, Math.min(6000, 1200 + text.length * 45));
    el._btBubble?.remove();
    const bubble = document.createElement("div");
    bubble.className = `bt-bubble${emote ? " bt-bubble-emote" : ""}`;
    bubble.innerHTML = `<b>${esc(el.querySelector(".bt-name").textContent)}</b>${esc(text)}`;
    this.root.append(bubble);
    el._btBubble = bubble;
    // La bulle se place du côté intérieur de l'écran, vers le centre de la ronde.
    const dx = this.path.cx - box.x, dy = this.path.cy - box.y, d = Math.hypot(dx, dy) || 1;
    const bx = box.x + dx / d * box.w * 0.9, by = box.y + dy / d * box.h * 0.65;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    bubble.style.left = `${clamp(bx - bw / 2, 8, window.innerWidth - bw - 8)}px`;
    bubble.style.top = `${clamp(by - bh / 2, 8, window.innerHeight - bh - 8)}px`;
    setTimeout(() => {
      bubble.classList.add("bt-fade");
      setTimeout(() => bubble.remove(), 450);
    }, BUBBLE_MS);
  }
};

/* ----------------------------------------------- fiches devant le théâtre */

// Le théâtre passe devant les fenêtres et widgets des autres modules, mais pas devant les fiches ni les dialogues :
// on le découpe là où ils se trouvent (clip-path troué, qui coupe aussi les clics), comme s'il était dessous.
const SHEETS = ".application.sheet, .application.dialog, .app.sheet, .app.dialog";

function windowRect(el) {
  if (!el.isConnected || el.hidden || !(el.checkVisibility?.() ?? true)) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

// Trous qui se chevauchent : la règle evenodd les rouvrirait. On découpe donc leur réunion en cases disjointes
// (grille tirée des bords de tous les trous) et on fusionne les cases voisines de chaque rangée.
function holesPath(rects) {
  const xs = [...new Set(rects.flatMap(r => [r.left, r.right]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [r.top, r.bottom]))].sort((a, b) => a - b);
  let d = "";
  for (let j = 0; j < ys.length - 1; j++) {
    const y = (ys[j] + ys[j + 1]) / 2;
    let start = null;
    for (let i = 0; i < xs.length; i++) {
      const x = (xs[i] + xs[i + 1]) / 2;
      const inside = i < xs.length - 1 && rects.some(r => x > r.left && x < r.right && y > r.top && y < r.bottom);
      if (inside && start === null) start = xs[i];
      if (!inside && start !== null) {
        d += `M${start} ${ys[j]}H${xs[i]}V${ys[j + 1]}H${start}Z`;
        start = null;
      }
    }
  }
  return d;
}

const Holes = {
  frame: 0,
  watched: new WeakSet(),
  observer: null,

  start() {
    // Déplacement, redimensionnement, réduction : Foundry réécrit le style ou les classes de la fenêtre.
    this.observer = new MutationObserver(() => this.update());
    // Les fenêtres s'ajoutent et se retirent directement dans <body>.
    new MutationObserver(() => this.update()).observe(document.body, { childList: true });
    this.update();
  },

  update() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.cut();
    });
  },

  cut() {
    const root = Stage.root;
    if (!root) return;
    const o = root.getBoundingClientRect();
    const rects = [];
    for (const el of document.querySelectorAll(SHEETS)) {
      if (!this.watched.has(el)) {
        this.watched.add(el);
        this.observer.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
      }
      const r = windowRect(el);
      if (r) rects.push({ left: r.left - o.left, right: r.right - o.left, top: r.top - o.top, bottom: r.bottom - o.top });
    }
    root.style.clipPath = rects.length
      ? `path(evenodd, "M0 0H${o.width}V${o.height}H0Z${holesPath(rects)}")`
      : "";
  }
};

/* ---------------------------------------------- bouton près du chat */

// Un seul bouton : il ouvre un menu (vers le haut, ou sur le côté quand le chat flotte, barre latérale repliée).
// Pastille sur le bouton quand le théâtre est masqué chez moi ou que le rideau est baissé.
function injectControls() {
  const controls = document.getElementById("chat-controls");
  if (!controls) return;
  let group = controls.querySelector(".bt-controls");
  if (!group) {
    group = document.createElement("div");
    group.className = "bt-controls";
    group.innerHTML = `<button type="button" class="ui-control icon fa-solid fa-masks-theater" data-bt="menu" aria-expanded="false"></button>`;
    const button = group.firstElementChild;
    button.addEventListener("click", () => Panel.toggle(button));
    // Un acteur glissé depuis l'onglet Acteurs rejoint le théâtre.
    button.addEventListener("dragover", event => event.preventDefault());
    button.addEventListener("drop", event => {
      event.preventDefault();
      const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
      if (data?.type !== "Actor") return;
      const actor = fromUuidSync(data.uuid);
      if (!actor?.isOwner) return void ui.notifications.warn("Better Theater : ce personnage ne vous appartient pas.");
      if (!isStaged(actor)) request("addActor", { actorId: actor.id });
    });
    const before = controls.querySelector(".control-buttons");
    if (before) controls.insertBefore(group, before);
    else controls.append(group);
  }
  const button = group.querySelector('[data-bt="menu"]');
  const { curtain, hands } = readStage();
  const hidden = !!setting("hidden");
  // Chez le MJ : nombre de mains levées sur le bouton.
  const count = game.user.isGM ? hands.length : 0;
  let badge = button.querySelector(".bt-count");
  if (count) {
    badge ??= button.appendChild(Object.assign(document.createElement("span"), { className: "bt-count" }));
    badge.textContent = count;
  } else badge?.remove();
  const state = [count && `${count} main${count > 1 ? "s levées" : " levée"}`,
    hidden && "masqué chez moi", curtain && "rideau baissé"].filter(Boolean).join(", ");
  const tip = `Better Theater${state ? ` (${state})` : ""}`;
  button.classList.toggle("bt-alert", hidden || curtain);
  button.dataset.tooltip = tip;
  button.setAttribute("aria-label", tip);
  Panel.refresh();
}

// Personnages proposés : ceux dont je suis propriétaire (tous pour le MJ), sans les modèles (type « _template »
// de Custom System Builder). Mon personnage attitré d'abord, puis ceux des joueurs, puis l'ordre alphabétique.
function stageableActors() {
  const mine = game.user.character?.id;
  const rank = a => (a.id === mine ? 0 : a.hasPlayerOwner ? 1 : 2);
  return game.actors.filter(a => a.isOwner && !a.type.startsWith("_"))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "fr"));
}

const fold = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const LIST_MAX = 50;

const Panel = {
  el: null,
  button: null,
  view: "main",   // « main », « actors » ou « hand » (main levée d'un joueur, depuis la liste des joueurs)
  userId: null,
  query: "",
  lazy: null,

  toggle(button, view = "main", userId = null) {
    if (this.el) return this.close();
    this.button = button;
    this.view = view;
    this.userId = userId;
    this.query = "";
    this.el = document.createElement("div");
    this.el.id = "bt-panel";
    this.el.addEventListener("click", event => this.onClick(event));
    this.el.addEventListener("input", event => {
      if (!event.target.matches(".bt-search")) return;
      this.query = event.target.value;
      this.drawList();
    });
    document.body.append(this.el);
    this.button.setAttribute("aria-expanded", "true");
    this.draw();
  },

  close() {
    this.lazy?.disconnect();
    this.el?.remove();
    this.button?.setAttribute("aria-expanded", "false");
    this.el = this.button = this.lazy = null;
  },

  // Le théâtre a changé (ou le masquage) : on redessine, sans perdre la recherche en cours.
  refresh() {
    if (!this.el) return;
    if (!this.button?.isConnected) return this.close();
    if (this.view === "hand" && !handOf(this.userId)) return this.close();
    if (this.view === "actors") this.drawList();
    else this.draw();
  },

  item(act, icon, label, { on = false, danger = false, more = false, disabled = false, tail = null, user = null } = {}) {
    return `<button type="button" class="bt-item${on ? " bt-on" : ""}" data-act="${act}"${user ? ` data-user="${user}"` : ""}`
      + `${danger ? " data-danger" : ""}${disabled ? " disabled" : ""}>`
      + `<i class="fa-solid ${icon}"></i><span>${label}</span>`
      + (on ? `<i class="fa-solid fa-check bt-tail"></i>` : more ? `<i class="fa-solid fa-chevron-right bt-tail"></i>`
        : tail ? `<i class="fa-solid ${tail} bt-tail"></i>` : "")
      + `</button>`;
  },

  // MJ : mains levées dans l'ordre de la file ; un clic donne la parole.
  handItems(stage) {
    if (!stage.hands.length) return "";
    return `<div class="bt-label">Mains levées</div>`
      + stage.hands.map((h, i) => {
        const user = game.users.get(h.userId);
        const entry = handEntry(h, stage.entries);
        const name = entry ? describe(entry)?.name : user?.character?.name;
        const label = `${i + 1}. ${esc(user?.name ?? "?")}${name ? ` <small>${esc(name)}</small>` : ""}`;
        return this.item("floor", "fa-hand", label, { tail: "fa-microphone", user: h.userId });
      }).join("")
      + this.item("lower-all", "fa-hand-back-fist", stage.hands.length > 1 ? "Baisser toutes les mains" : "Baisser la main")
      + `<div class="bt-sep"></div>`;
  },

  draw() {
    this.lazy?.disconnect();
    const stage = readStage();
    const hidden = !!setting("hidden");
    let html;
    if (this.view === "hand") {
      const user = game.users.get(this.userId);
      html = `<div class="bt-head"><i class="fa-solid fa-hand"></i><span>${esc(user?.name ?? "?")}</span></div>`
        + this.item("floor", "fa-microphone", "Donner la parole", { user: this.userId })
        + this.item("lower", "fa-hand-back-fist", "Baisser la main", { user: this.userId });
    } else if (this.view === "actors") {
      const search = game.user.isGM || stageableActors().length > 8;
      html = `<div class="bt-head"><button type="button" class="bt-back" data-act="back" aria-label="Retour"><i class="fa-solid fa-chevron-left"></i></button>`
        + `<span>${game.user.isGM ? "Ajouter un personnage" : "Mes personnages"}</span></div>`
        + (search ? `<input type="search" class="bt-search" placeholder="Rechercher…" value="${esc(this.query)}">` : "")
        + `<div class="bt-list"></div>`;
    } else if (game.user.isGM) {
      html = this.handItems(stage)
        + this.item("image", "fa-image", "Ajouter une image")
        + this.item("actors", "fa-user-plus", "Ajouter un personnage", { more: true })
        + this.item("curtain", "fa-person-booth", "Masquer chez tout le monde", { on: stage.curtain })
        + this.item("hide", "fa-eye-slash", "Masquer chez moi", { on: hidden })
        + this.item("clear", "fa-trash", "Vider le théâtre", { danger: true, disabled: !stage.entries.length });
    } else {
      const mine = stageableActors();
      const staged = mine.filter(isStaged);
      html = "";
      if (mine.length === 1 && !staged.length) html += this.item("add", "fa-user-plus", `Ajouter ${esc(mine[0].name)}`);
      if (mine.length > 1) html += this.item("actors", "fa-user-plus",
        staged.length < mine.length ? "Ajouter mon personnage" : "Mes personnages", { more: true });
      html += this.item("hide", "fa-eye-slash", "Masquer chez moi", { on: hidden });
      if (staged.length) html += this.item("remove-mine", "fa-user-minus",
        staged.length > 1 ? `Retirer mes personnages (${staged.length})` : `Retirer ${esc(staged[0].name)}`, { danger: true });
    }
    this.el.innerHTML = html;
    this.el.classList.toggle("bt-wide", this.view === "actors");
    if (this.view === "actors") this.drawList();
    this.position();
    this.el.querySelector(".bt-search")?.focus();
  },

  drawList() {
    const list = this.el?.querySelector(".bt-list");
    if (!list) return;
    this.lazy?.disconnect();
    const top = list.scrollTop;   // cocher une ligne redessine la liste : on garde la position
    const q = fold(this.query.trim());
    const found = stageableActors().filter(a => !q || fold(a.name).includes(q));
    const shown = found.slice(0, LIST_MAX);
    list.innerHTML = shown.map(a => {
      const on = isStaged(a);
      return `<button type="button" class="bt-item bt-actor${on ? " bt-on" : ""}" data-act="actor" data-actor="${a.id}">`
        + `<img alt="" draggable="false"><span>${esc(a.name)}</span>`
        + `<i class="fa-solid ${on ? "fa-check" : "fa-plus"} bt-tail"></i></button>`;
    }).join("")
      + (!found.length ? `<p class="bt-note">Aucun personnage.</p>` : "")
      + (found.length > LIST_MAX ? `<p class="bt-note">${found.length - LIST_MAX} autres : précisez la recherche.</p>` : "");
    // Vignettes tirées seulement quand la ligne apparaît : certaines images de fiche sont énormes.
    this.lazy = new IntersectionObserver(seen => {
      for (const { isIntersecting, target } of seen) {
        if (!isIntersecting) continue;
        this.lazy.unobserve(target);
        const img = target.querySelector("img");
        thumbnail(describe({ actorId: target.dataset.actor })?.img ?? FALLBACK_IMG).then(src => { img.src = src; });
      }
    }, { root: list });
    list.querySelectorAll(".bt-actor").forEach(row => this.lazy.observe(row));
    list.scrollTop = top;
    this.position();
  },

  position() {
    if (!this.el || !this.button) return;
    const r = this.button.getBoundingClientRect();
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    // Liste des joueurs (en bas à gauche) : à droite de la ligne. Chat flottant : à gauche du bouton. Sinon au-dessus.
    const players = !!this.button.closest("#players");
    const side = !!this.button.closest("#chat-notifications");
    const x = players ? r.right + 6 : side ? r.left - w - 6 : r.right - w;
    const y = players || side ? r.bottom - h : r.top - h - 6;
    this.el.style.left = `${clamp(x, 8, window.innerWidth - w - 8)}px`;
    this.el.style.top = `${clamp(y, 8, window.innerHeight - h - 8)}px`;
  },

  async onClick(event) {
    const b = event.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "actors" || act === "back") {
      this.view = act === "actors" ? "actors" : "main";
      this.query = "";
      return this.draw();
    }
    if (act === "actor") return toggleActor(game.actors.get(b.dataset.actor));
    if (act === "hide") return game.settings.set(ID, "hidden", !setting("hidden"));
    if (act === "curtain") return request("curtain");
    const mine = stageableActors();
    this.close();
    if (act === "floor") return giveFloor(b.dataset.user);
    if (act === "lower") return request("lowerHand", { userId: b.dataset.user });
    if (act === "lower-all") return request("lowerAll");
    if (act === "image") pickImage();
    else if (act === "add") request("addActor", { actorId: mine[0]?.id });
    else if (act === "remove-mine") mine.filter(isStaged).forEach(a => request("removeActor", { actorId: a.id }));
    else if (act === "clear") {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Vider le théâtre" },
        content: "<p>Retirer tous les portraits du théâtre ?</p>",
        rejectClose: false
      });
      if (ok) request("clear");
    }
  }
};

/* ------------------------------------------------------------- bulles */

// Réplique dite par un personnage du théâtre : texte simple, ni jet ni carte de fiche, hors HRP.
function onChatMessage(message) {
  if (!setting("bubbles") || !message.visible || message.isRoll) return;
  const styles = CONST.CHAT_MESSAGE_STYLES;
  if (message.style === styles.OOC) return;
  const actorId = message.speaker?.actor;
  const entry = actorId && readStage().entries.find(e => e.actorId === actorId);
  if (!entry) return;
  const html = String(message.content ?? "");
  if (/<(div|table|section|img|video|form|ol|ul)\b/i.test(html)) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = html.replace(/<br\s*\/?>/gi, " ");
  let text = tmp.textContent.replace(/\s+/g, " ").trim();
  if (!text) return;
  if (text.length > 220) text = `${text.slice(0, 217)}…`;
  Stage.say(entry.id, text, { emote: message.style === styles.EMOTE });
}

/* ------------------------------------------------------------------ hooks */

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(ID, key, { config: false, ...data });
  reg("stage", {
    scope: "world", type: Object, default: { entries: [], focus: null, curtain: false, hands: [] },
    onChange: () => { Stage.render(); injectControls(); onHandsChanged(); }
  });
  reg("max", {
    scope: "world", config: true, type: Number, default: 12,
    choices: { 8: "8", 10: "10", 12: "12", 16: "16" },
    name: "Portraits affichés au maximum",
    hint: "Au-delà, les images les plus anciennes du MJ se rangent dans une pastille « +N ». Les personnages joueurs restent toujours visibles.",
    onChange: () => Stage.render()
  });
  reg("bubbles", {
    scope: "world", config: true, type: Boolean, default: true,
    name: "Bulles de répliques",
    hint: "Une réplique écrite dans le chat par un personnage présent dans le théâtre s'affiche quelques secondes près de son portrait.",
  });
  reg("scale", {
    scope: "client", config: true, type: Number, default: 1,
    choices: { 0.75: "Petits", 1: "Normaux", 1.25: "Grands" },
    name: "Taille des portraits",
    hint: "Sur cet ordinateur seulement.",
    onChange: () => Stage.render()
  });
  reg("handSound", {
    scope: "client", config: true, type: Boolean, default: true,
    name: "Son des mains levées",
    hint: "Pour le MJ : un petit son quand un joueur lève la main (Alt+L ou menu de son portrait)."
  });
  reg("hidden", {
    scope: "client", type: Boolean, default: false,
    onChange: () => { Stage.render(); injectControls(); }
  });

  game.keybindings.register(ID, "toggle", {
    name: "Masquer / afficher le théâtre",
    hint: "Sur cet ordinateur seulement.",
    editable: [{ key: "KeyH", modifiers: ["Alt"] }],
    onDown: () => { game.settings.set(ID, "hidden", !setting("hidden")); return true; }
  });
  game.keybindings.register(ID, "hand", {
    name: "Lever / baisser la main",
    hint: "Joueurs : demander la parole au MJ. La main s'affiche sur le portrait et dans la liste des joueurs.",
    // Touche à la même place en AZERTY et QWERTY : Foundry lit la position physique (event.code), Alt+M
    // tombait sur la virgule des claviers français.
    editable: [{ key: "KeyL", modifiers: ["Alt"] }],
    onDown: () => {
      if (game.user.isGM) return false;
      toggleHand();
      return true;
    }
  });
});

Hooks.once("ready", () => {
  Stage.build();
  Holes.start();
  injectControls();
  knownHands = new Set(readStage().hands.map(h => h.userId));
  decoratePlayers();
  game.socket.on(SOCKET, onSocket);

  window.addEventListener("resize", () => {
    Stage.render();
    Holes.update();
    Panel.close();
  });
  const sidebar = document.getElementById("sidebar");
  if (sidebar) new ResizeObserver(() => Stage.render()).observe(sidebar);
  document.addEventListener("pointerdown", event => {
    if (Stage.menu && !Stage.menu.contains(event.target) && !event.target.closest?.(".bt-pt")) Stage.closeMenu();
    if (Panel.el && !Panel.el.contains(event.target) && !Panel.button?.contains(event.target)) Panel.close();
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    Stage.closeMenu();
    Panel.close();
  });

  if (isLeadGM()) run("prune", {}, game.user);

  game.modules.get(ID).api = {
    add: actor => request("addActor", { actorId: actor?.id ?? actor }),
    remove: actor => request("removeActor", { actorId: actor?.id ?? actor }),
    addImage: (img, name) => request("addImage", { img, name }),
    clear: () => request("clear"),
    lowerHands: () => request("lowerAll"),
    // Fait « parler » un portrait chez tout le monde (entrée du théâtre ou id de personnage).
    speak: (idOrActor, ms = 1500) => {
      const key = idOrActor?.id ?? idOrActor;
      const entry = readStage().entries.find(e => e.id === key || e.actorId === key);
      if (!entry) return;
      Stage.speak(entry.id, ms);
      game.socket.emit(SOCKET, { type: "speak", id: entry.id, ms });
    }
  };
});

Hooks.on("renderChatInput", () => injectControls());
Hooks.on("collapseSidebar", () => {
  Panel.close();
  setTimeout(() => Stage.render(), 260);
});
Hooks.on("canvasReady", () => Stage.render());
Hooks.on("clientSettingChanged", key => { if (key === "core.performanceMode") Stage.render(); });
Hooks.on("createChatMessage", onChatMessage);
Hooks.on("renderPlayers", () => decoratePlayers());
// Un joueur qui part baisse sa main.
Hooks.on("userConnected", (user, active) => {
  if (!active && isLeadGM() && handOf(user.id)) run("lowerHand", { userId: user.id }, game.user);
});

const watched = actor => readStage().entries.some(e => e.actorId === actor?.id);
Hooks.on("updateActor", actor => { if (watched(actor)) Stage.render(); });
Hooks.on("updateUser", () => Stage.render());
Hooks.on("deleteActor", actor => { if (isLeadGM() && watched(actor)) run("prune", {}, game.user); });

// Fiches (ApplicationV2, dont celles de CSB) : bouton dans le menu de l'en-tête.
Hooks.on("getHeaderControlsDocumentSheetV2", (app, controls) => {
  const actor = app.document;
  if (actor?.documentName !== "Actor" || !actor.isOwner) return;
  const staged = isStaged(actor);
  controls.unshift({
    action: "betterTheater",
    icon: staged ? "fa-solid fa-mask" : "fa-solid fa-masks-theater",
    label: staged ? "Retirer du théâtre" : "Ajouter au théâtre",
    onClick: () => toggleActor(actor)
  });
});

// Anciennes fiches (Application V1).
Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
  const actor = app.document ?? app.actor;
  if (!actor?.isOwner) return;
  buttons.unshift({
    label: "Théâtre",
    class: "bt-header",
    icon: "fa-solid fa-masks-theater",
    onclick: () => toggleActor(actor)
  });
});

// Clic droit sur un personnage dans l'onglet Acteurs.
Hooks.on("getActorContextOptions", (app, options) => {
  const actorOfLi = li => game.actors.get((li?.[0] ?? li)?.closest?.("[data-entry-id]")?.dataset.entryId);
  options.push({
    label: "Ajouter au théâtre",
    icon: "fa-solid fa-masks-theater",
    visible: li => { const a = actorOfLi(li); return !!a?.isOwner && !isStaged(a); },
    onClick: (_event, li) => request("addActor", { actorId: actorOfLi(li)?.id })
  }, {
    label: "Retirer du théâtre",
    icon: "fa-solid fa-mask",
    visible: li => { const a = actorOfLi(li); return !!a?.isOwner && isStaged(a); },
    onClick: (_event, li) => request("removeActor", { actorId: actorOfLi(li)?.id })
  });
});

// HUD du jeton : bouton dans la colonne de droite.
Hooks.on("renderTokenHUD", (hud, html) => {
  const actor = hud.object?.actor;
  if (!actor?.isOwner) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const column = root?.querySelector(".col.right");
  if (!column) return;
  const staged = isStaged(actor);
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("control-icon", "bt-hud-button");
  if (staged) button.classList.add("active");
  button.dataset.tooltip = staged ? "Retirer du théâtre" : "Ajouter au théâtre";
  button.innerHTML = `<i class="fa-solid fa-masks-theater"></i>`;
  button.addEventListener("click", event => {
    event.preventDefault();
    toggleActor(actor);
    hud.close();
  });
  column.append(button);
});
