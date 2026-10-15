const MODULE_ID = "apng-cutin";
const SOCKET = `module.${MODULE_ID}`;
const VIDEO_EXT = /\.(webm|mp4|m4v|ogv)(\?.*)?$/i;

const DEFAULTS = {
  src: "",
  duration: 4,      // secondes ; 0 = reste affiché jusqu'au clic / fermeture par le MJ
  fit: "contain",   // contain | cover | stretch
  dim: 0,           // opacité du fond noir, 0 à 1
  fade: 250,        // ms
  sound: "",
  volume: 0.8,
  clickToClose: true
};

const APNG_EXT = /\.a?png(?=\?|$)/i;

// Safari (et tous les navigateurs d'iPhone / iPad, qui sont des Safari déguisés) ne gère pas la
// transparence des WebM : il garde l'APNG.
const WEBM_ALPHA = !(/AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent));

let current = null;

/* -------------------------------------------- */
/*  Chargement (une seule fois par fichier)     */
/* -------------------------------------------- */

// src → Promise<{ blob, isVideo, loop }>. Le fichier ne passe qu'une fois par le réseau (donc par
// la connexion de l'hôte) ; chaque affichage en refait ensuite une URL blob neuve, pour que l'animation
// reparte toujours de la première frame.
const cache = new Map();

function load(src) {
  if (!cache.has(src)) {
    const promise = fetchMedia(src);
    promise.catch(() => cache.delete(src));
    cache.set(src, promise);
  }
  return cache.get(src);
}

/** Un APNG accompagné d'un WebM du même nom (outils/convertir-cutins.py) est remplacé par ce WebM, bien plus léger. */
async function fetchMedia(src) {
  if (WEBM_ALPHA && APNG_EXT.test(src)) {
    const webm = await fetch(src.replace(APNG_EXT, ".webm")).catch(() => null);
    if (webm?.ok) return { blob: await webm.blob(), isVideo: true, loop: await apngLoops(src) };
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return { blob: await response.blob(), isVideo: VIDEO_EXT.test(src), loop: false };
}

/** L'APNG tourne-t-il en boucle ? (champ num_plays du bloc acTL, lu dans les premiers octets seulement.) */
async function apngLoops(src) {
  try {
    const reader = (await fetch(src, { headers: { Range: "bytes=0-255" } })).body.getReader();
    let bytes = new Uint8Array(0);
    while (bytes.length < 256) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes = new Uint8Array([...bytes, ...value.subarray(0, 256 - bytes.length)]);
    }
    reader.cancel();
    const view = new DataView(bytes.buffer);
    for (let i = 8; i + 16 <= bytes.length; i += 12 + view.getUint32(i)) {
      const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
      if (type === "acTL") return view.getUint32(i + 12) === 0;
      if (type === "IDAT") break;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Boucle de ${src} illisible`, err);
  }
  return false;
}

/** Charge à l'avance les animations de résultat de jet : rien ne transite plus par le réseau au moment du jet. */
function preloadResults() {
  for (const id of Object.keys(ROLL_RESULTS)) {
    const src = game.settings.get(MODULE_ID, `result-${id}`);
    if (src) load(src).catch(err => console.error(`${MODULE_ID} | Impossible de charger ${src}`, err));
  }
}

/* -------------------------------------------- */
/*  Affichage local                             */
/* -------------------------------------------- */

async function display(options) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.src) return;
  hide({ instant: true });

  let media;
  try {
    media = await load(opts.src);
  } catch (err) {
    console.error(`${MODULE_ID} | Impossible de charger ${opts.src}`, err);
    ui.notifications?.error(`APNG Cut-in : impossible de charger ${opts.src}`);
    return;
  }
  const objectUrl = URL.createObjectURL(media.blob);

  const layer = document.createElement("div");
  layer.id = "apng-cutin-layer";
  layer.style.setProperty("--cutin-fade", `${opts.fade}ms`);
  layer.style.background = `rgba(0, 0, 0, ${Number(opts.dim) || 0})`;
  if (opts.fit !== "contain") layer.classList.add(opts.fit);
  if (opts.clickToClose) layer.classList.add("clickable");

  const isVideo = media.isVideo;
  const element = document.createElement(isVideo ? "video" : "img");
  if (isVideo) Object.assign(element, { autoplay: true, muted: true, playsInline: true, loop: media.loop });
  await new Promise(resolve => {
    element.addEventListener(isVideo ? "loadeddata" : "load", resolve, { once: true });
    element.addEventListener("error", resolve, { once: true });
    element.src = objectUrl;
  });
  layer.append(element);
  document.body.append(layer);

  const state = { layer, objectUrl, timeout: null };
  current = state;

  if (opts.clickToClose) layer.addEventListener("click", () => hide());
  if (isVideo && !opts.duration) element.addEventListener("ended", () => hide(), { once: true });
  if (opts.duration > 0) state.timeout = setTimeout(() => hide(), opts.duration * 1000);

  if (opts.sound) {
    foundry.audio.AudioHelper.play({ src: opts.sound, volume: Number(opts.volume), loop: false }, false);
  }

  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("visible")));
}

function hide({ instant = false } = {}) {
  const state = current;
  if (!state) return;
  current = null;
  clearTimeout(state.timeout);
  const cleanup = () => {
    state.layer.remove();
    URL.revokeObjectURL(state.objectUrl);
  };
  if (instant) return cleanup();
  state.layer.classList.remove("visible");
  const fade = parseFloat(state.layer.style.getPropertyValue("--cutin-fade")) || 0;
  setTimeout(cleanup, fade + 50);
}

/* -------------------------------------------- */
/*  Diffusion                                   */
/* -------------------------------------------- */

/** Affiche le cut-in chez tout le monde (MJ inclus). */
function show(options) {
  if (typeof options === "string") options = { src: options };
  game.socket.emit(SOCKET, { action: "show", options });
  return display(options);
}

/** Ferme le cut-in chez tout le monde. */
function close() {
  game.socket.emit(SOCKET, { action: "hide" });
  hide();
}

/* -------------------------------------------- */
/*  Fenêtre MJ                                  */
/* -------------------------------------------- */

async function openDialog() {
  const last = { ...DEFAULTS, ...game.settings.get(MODULE_ID, "last") };
  const fitOption = (value, label) =>
    `<option value="${value}" ${last.fit === value ? "selected" : ""}>${label}</option>`;

  const content = `
    <div class="form-group">
      <label>Fichier</label>
      <div class="form-fields"><file-picker name="src" type="imagevideo" value="${last.src}"></file-picker></div>
    </div>
    <div class="form-group">
      <label>Durée (s)</label>
      <div class="form-fields"><input type="number" name="duration" min="0" step="0.1" value="${last.duration}"></div>
      <p class="hint">0 = reste affiché jusqu'au clic (ou fin de la vidéo).</p>
    </div>
    <div class="form-group">
      <label>Cadrage</label>
      <div class="form-fields"><select name="fit">
        ${fitOption("contain", "Entier (contain)")}
        ${fitOption("cover", "Remplir l'écran (cover)")}
        ${fitOption("stretch", "Étirer")}
      </select></div>
    </div>
    <div class="form-group">
      <label>Assombrir le fond</label>
      <div class="form-fields"><input type="range" name="dim" min="0" max="1" step="0.05" value="${last.dim}"></div>
    </div>
    <div class="form-group">
      <label>Son (optionnel)</label>
      <div class="form-fields"><file-picker name="sound" type="audio" value="${last.sound}"></file-picker></div>
    </div>
    <div class="form-group">
      <label>Clic pour fermer</label>
      <div class="form-fields"><input type="checkbox" name="clickToClose" ${last.clickToClose ? "checked" : ""}></div>
    </div>`;

  const options = await foundry.applications.api.DialogV2.prompt({
    window: { title: "APNG Cut-in", icon: "fa-solid fa-film" },
    position: { width: 480 },
    content,
    ok: {
      label: "Afficher à tous",
      icon: "fa-solid fa-play",
      callback: (event, button) => {
        const form = button.form;
        const field = name => form.querySelector(`[name="${name}"]`);
        return {
          src: field("src").value?.trim(),
          duration: Number(field("duration").value) || 0,
          fit: field("fit").value,
          dim: Number(field("dim").value) || 0,
          sound: field("sound").value?.trim(),
          clickToClose: field("clickToClose").checked
        };
      }
    },
    rejectClose: false
  });
  if (!options?.src) return;
  await game.settings.set(MODULE_ID, "last", options);
  show(options);
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

/* -------------------------------------------- */
/*  Cut-ins de résultat de jet                  */
/* -------------------------------------------- */

// Les jets de la fiche CSB glissent dans leur message une balise invisible :
// <span class=jdr-cutin data-result=crit-success></span>
const ROLL_RESULTS = {
  "crit-success": "Réussite critique",
  "success": "Succès",
  "close-success": "Succès serré",
  "fail": "Échec",
  "crit-fail": "Échec critique"
};
const RESULT_MARKER = /data-result=["']?([\w-]+)/;

Hooks.on("createChatMessage", message => {
  // Seul le lanceur du dé voit l'animation.
  if (message.author?.id !== game.user.id) return;
  const result = message.content?.match(RESULT_MARKER)?.[1];
  if (!(result in ROLL_RESULTS)) return;
  const src = game.settings.get(MODULE_ID, `result-${result}`);
  if (!src) return;
  const delay = game.settings.get(MODULE_ID, "resultDelay") * 1000;
  setTimeout(() => display({
    src,
    duration: game.settings.get(MODULE_ID, "resultDuration"),
    fit: "contain",
    dim: 0,
    clickToClose: true
  }), delay);
});

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "last", {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  for (const [id, label] of Object.entries(ROLL_RESULTS)) {
    game.settings.register(MODULE_ID, `result-${id}`, {
      name: `Jet : ${label}`,
      hint: "APNG (ou GIF / WebM) affiché uniquement chez le joueur qui a lancé le dé. Laisser vide pour ne rien afficher.",
      scope: "world",
      config: true,
      type: String,
      filePicker: "imagevideo",
      default: "",
      onChange: src => { if (src) load(src).catch(() => {}); }
    });
  }
  game.settings.register(MODULE_ID, "resultDelay", {
    name: "Jet : délai avant l'animation (s)",
    hint: "Temps entre l'apparition du jet dans le chat et l'animation.",
    scope: "world",
    config: true,
    type: Number,
    default: 2
  });
  game.settings.register(MODULE_ID, "resultDuration", {
    name: "Jet : durée de l'animation (s)",
    hint: "0 = reste affiché jusqu'au clic.",
    scope: "world",
    config: true,
    type: Number,
    default: 2.5
  });

  game.modules.get(MODULE_ID).api = { show, close, openDialog };
});

Hooks.once("ready", () => {
  preloadResults();
  game.socket.on(SOCKET, data => {
    if (data?.action === "show") display(data.options);
    else if (data?.action === "hide") hide();
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tokens = controls.tokens;
  if (!tokens?.tools) return;
  tokens.tools.apngCutin = {
    name: "apngCutin",
    title: "APNG Cut-in",
    icon: "fa-solid fa-film",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => openDialog()
  };
});
