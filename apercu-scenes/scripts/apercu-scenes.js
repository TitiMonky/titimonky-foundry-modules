// Aperçu des scènes : pour le MJ, survoler une scène de la barre de navigation (en haut à gauche) affiche sa
// miniature (`scene.thumb`, faite par Foundry à l'enregistrement d'une scène qui a un fond) à droite de la ligne.
// Remplace Scene Preview, qui visait l'ancienne barre horizontale (`#scene-list li`, disparue en v13).
// Écoute par délégation sur le document : rien à rebrancher quand Foundry redessine la barre.

const ID = "apercu-scenes";
const ROW = "#scene-navigation li.scene[data-scene-id]";

let box = null;
let current = null;

function hide() {
  current = null;
  box?.classList.remove("visible");
}

function show(li) {
  const scene = game.scenes.get(li.dataset.sceneId);
  // Comme Scene Preview : pas d'aperçu pour la scène qu'on regarde déjà.
  if (!scene?.thumb || li.classList.contains("view")) return hide();
  current = li;
  box.querySelector("img").src = scene.thumb;
  box.querySelector("figcaption").textContent = scene.name;
  const r = li.getBoundingClientRect();
  box.style.left = `${r.right + 12}px`;
  box.style.top = `${r.top}px`;
  box.classList.add("visible");
}

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  box = document.createElement("figure");
  box.id = ID;
  box.innerHTML = `<img alt=""><figcaption></figcaption>`;
  document.body.append(box);

  document.addEventListener("pointerover", ev => {
    const li = ev.target.closest?.(ROW);
    if (li && li !== current) show(li);
  });
  document.addEventListener("pointerout", ev => {
    if (current && !current.contains(ev.relatedTarget)) hide();
  });
  // Clic (changement de scène) ou barre redessinée : la ligne survolée n'est plus la même.
  document.addEventListener("pointerdown", hide, true);
  Hooks.on("renderSceneNavigation", hide);
});
