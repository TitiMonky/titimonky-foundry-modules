# Modules Foundry VTT de TitiMonky

Modules faits maison pour la campagne « Les Légendes de Meyiv », partagés tels quels.
Testés sur **Foundry VTT v14** (minimum v13). Interface en français.

## Installation

Dans Foundry : **Modules complémentaires → Installer un module**, coller le lien du manifeste en bas de la fenêtre,
puis **Installer**. Les mises à jour arrivent ensuite par le bouton habituel de Foundry.

| Module | Ce qu'il fait | Lien du manifeste |
|---|---|---|
| **Better Timer** | Minuteurs et chronomètres partagés : affichage déplaçable pour les joueurs, widget pause / reprise / arrêt pour le MJ. Les comptes à rebours survivent à un rechargement. | `https://raw.githubusercontent.com/TitiMonky/titimonky-foundry-modules/main/better-timer/module.json` |
| **Jukebox Meyiv** | Musique YouTube partagée pilotée par le MJ : bibliothèque en dossiers colorés, ajout de liens par lot, son ciblé sur certains joueurs, widget pour tous. | `https://raw.githubusercontent.com/TitiMonky/titimonky-foundry-modules/main/jukebox-meyiv/module.json` |
| **Better Theater** | Portraits des personnages en ronde ovale autour de l'écran, sans bloquer les clics ; répliques du chat en bulles. | `https://raw.githubusercontent.com/TitiMonky/titimonky-foundry-modules/main/better-theater/module.json` |
| **APNG Cut-in** | Cut-ins plein écran (APNG, GIF, WebP, WebM, avec son) lancés par le MJ ; animation sur résultat de jet chez le joueur qui lance. | `https://raw.githubusercontent.com/TitiMonky/titimonky-foundry-modules/main/apng-cutin/module.json` |
| **Quick Attack FX** | Bouton ATTAQUE dans le HUD du jeton : animations JB2A via Sequencer, sur les cibles ou le jeton. | `https://raw.githubusercontent.com/TitiMonky/titimonky-foundry-modules/main/attaque-fx/module.json` |
| **Better Scene Preview** | MJ : survoler une scène dans la barre de navigation affiche sa miniature et son nom complet. | `https://raw.githubusercontent.com/TitiMonky/titimonky-foundry-modules/main/apercu-scenes/module.json` |

## Bon à savoir

- **Quick Attack FX** demande [Sequencer](https://foundryvtt.com/packages/sequencer) et une bibliothèque JB2A
  (la version gratuite [JB2A_DnD5e](https://foundryvtt.com/packages/JB2A_DnD5e) suffit).
- **APNG Cut-in**, animations sur résultat de jet : le module réagit à une balise invisible dans le message de jet,
  à ajouter au message de la fiche (par exemple dans une formule de jet de Custom System Builder) :
  `<span class="jdr-cutin" data-result="crit-success"></span>`.
  Valeurs possibles : `crit-success`, `success`, `close-success`, `fail`, `crit-fail`. L'image de chaque résultat
  se choisit dans les réglages du module.
- **Better Timer** suit le thème clair / sombre de Foundry ; les autres restent dans leur palette parchemin.
- **Jukebox Meyiv** utilise le lecteur YouTube intégré ; la vidéo est masquée par défaut (réglage « Afficher la vidéo »
  dans le widget).

## Licence

Code sous licence MIT (voir `LICENSE`). Les sons de `better-timer/audio` ont leurs propres conditions :
voir `better-timer/audio/copyright.txt`.
