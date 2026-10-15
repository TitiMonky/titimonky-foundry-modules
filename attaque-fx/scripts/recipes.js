/**
 * Banque d'animations. Chaque recette décrit une attaque à partir des entrées
 * Sequencer de JB2A (préfixe "jb2a.", commun au gratuit et au Patreon).
 * Les recettes dont un fichier manque (ex. recettes Patreon sans le module
 * jb2a_patreon) sont masquées automatiquement.
 *
 * kind :
 *   "melee"      - l'arme part du lanceur vers la cible (stretchTo)
 *   "projectile" - projectile / rayon du lanceur vers la cible (stretchTo)
 *   "onTarget"   - l'effet se joue directement sur la cible
 *   "heal"       - comme onTarget, sans notion de touché / raté
 *   "aura"       - effet qui reste accroché au token (permanent par défaut), sans touché / raté
 *
 * Champs optionnels :
 *   cast      - effet joué sur le lanceur avant l'attaque
 *   impact    - effet joué sur la cible quand ça touche
 *   count     - nombre de projectiles (ex. projectiles magiques)
 *   scale     - taille de l'effet relative au token (onTarget / heal / impact)
 *   impactAt  - ms avant la fin de l'effet principal où l'impact se déclenche (négatif)
 *   sound     - chemin d'un son joué au lancement (ex. "assets/sons/epee.ogg")
 *   impactScale - taille de l'impact relative au token
 *   below     - effet sous le token (auras au sol, cercles)
 *   offsetY   - décalage vertical en cases (négatif = au-dessus de la tête)
 *   spread    - projectiles dispersés autour de la cible (rafale, tromblon)
 */
export const RECIPES = [
  // --- Mêlée -------------------------------------------------------------
  { id: "sword", group: "Mêlée", label: "Épée", kind: "melee", file: "jb2a.sword.melee.01.white", impact: "jb2a.impact.004.blue" },
  { id: "greatsword", group: "Mêlée", label: "Épée à deux mains", kind: "melee", file: "jb2a.melee_attack.03.greatsword.01", impact: "jb2a.impact.009.orange" },
  { id: "rapier", group: "Mêlée", label: "Rapière", kind: "melee", file: "jb2a.rapier.melee.01.white", impact: "jb2a.impact.004.blue" },
  { id: "katana", group: "Mêlée", label: "Katana", kind: "melee", file: "jb2a.melee_attack.04.katana.01", impact: "jb2a.impact.004.blue" },
  { id: "dagger", group: "Mêlée", label: "Dague", kind: "melee", file: "jb2a.dagger.melee.02.white", impact: "jb2a.impact.004.blue" },
  { id: "spear", group: "Mêlée", label: "Lance", kind: "melee", file: "jb2a.spear.melee.01.white", impact: "jb2a.impact.004.blue" },
  { id: "battleaxe", group: "Mêlée", label: "Hache", kind: "melee", file: "jb2a.melee_attack.02.battleaxe.01", impact: "jb2a.impact.009.orange" },
  { id: "greataxe", group: "Mêlée", label: "Grande hache", kind: "melee", file: "jb2a.melee_attack.03.greataxe.01", impact: "jb2a.impact.009.orange" },
  { id: "warhammer", group: "Mêlée", label: "Marteau de guerre", kind: "melee", file: "jb2a.melee_attack.02.warhammer.01", impact: "jb2a.impact.ground_crack.orange.01" },
  { id: "mace", group: "Mêlée", label: "Masse", kind: "melee", file: "jb2a.melee_attack.02.mace.01", impact: "jb2a.impact.009.orange" },
  { id: "maul", group: "Mêlée", label: "Maillet", kind: "melee", file: "jb2a.melee_attack.03.maul.01", impact: "jb2a.impact.ground_crack.orange.01" },
  { id: "scythe", group: "Mêlée", label: "Faux", kind: "melee", file: "jb2a.melee_attack.05.scythe.01", impact: "jb2a.impact.004.blue" },
  { id: "flail", group: "Mêlée", label: "Fléau", kind: "melee", file: "jb2a.melee_attack.01.flail.01", impact: "jb2a.impact.009.orange" },
  { id: "unarmed", group: "Mêlée", label: "Mains nues", kind: "melee", file: "jb2a.unarmed_strike.physical.01.blue", impact: "jb2a.impact.004.blue" },
  { id: "unarmed-magic", group: "Mêlée", label: "Poing magique", kind: "melee", file: "jb2a.unarmed_strike.magical.01.blue", impact: "jb2a.impact.011.blue" },
  { id: "claws", group: "Mêlée", label: "Griffes", kind: "onTarget", file: "jb2a.claws.400px.red", scale: 1.5 },
  { id: "bite", group: "Mêlée", label: "Morsure", kind: "onTarget", file: "jb2a.bite.400px.red", scale: 1.5 },

  // Patreon
  { id: "sword-fire", group: "Mêlée", label: "Épée enflammée", kind: "melee", file: "jb2a.sword.melee.fire.orange", impact: "jb2a.impact.fire.01.orange" },
  { id: "greatclub-fire", group: "Mêlée", label: "Massue enflammée", kind: "melee", file: "jb2a.greatclub.fire.orange", impact: "jb2a.impact.009.orange" },
  { id: "flurry", group: "Mêlée", label: "Déluge de coups", kind: "melee", file: "jb2a.flurry_of_blows.magical.01.blue", impact: "jb2a.impact.011.blue" },
  { id: "sneak-attack", group: "Mêlée", label: "Attaque sournoise", kind: "onTarget", file: "jb2a.sneak_attack.dark_red", scale: 1.6 },

  // --- Distance -----------------------------------------------------------
  { id: "arrow", group: "Distance", label: "Arc", kind: "projectile", file: "jb2a.arrow.physical.white.01", impact: "jb2a.impact.004.blue" },
  { id: "arrow-poison", group: "Distance", label: "Flèche empoisonnée", kind: "projectile", file: "jb2a.arrow.poison.green.01", impact: "jb2a.impact.004.blue" },
  { id: "bolt", group: "Distance", label: "Arbalète", kind: "projectile", file: "jb2a.bolt.physical.orange", impact: "jb2a.impact.009.orange" },
  { id: "dagger-throw", group: "Distance", label: "Dague lancée", kind: "projectile", file: "jb2a.dagger.throw.01.white", impact: "jb2a.impact.004.blue" },

  // Patreon
  { id: "arrow-fire", group: "Distance", label: "Flèche de feu", kind: "projectile", file: "jb2a.arrow.fire.orange", impact: "jb2a.impact.fire.01.orange" },
  { id: "arrow-lightning", group: "Distance", label: "Flèche de foudre", kind: "projectile", file: "jb2a.arrow.lightning.blue", impact: "jb2a.impact.011.blue" },
  { id: "javelin", group: "Distance", label: "Javelot", kind: "projectile", file: "jb2a.javelin.01.throw", impact: "jb2a.impact.004.blue" },
  { id: "shuriken", group: "Distance", label: "Shuriken", kind: "projectile", file: "jb2a.shuriken.01", impact: "jb2a.impact.004.blue" },
  { id: "hammer-throw", group: "Distance", label: "Marteau lancé", kind: "projectile", file: "jb2a.hammer.throw", impact: "jb2a.impact.ground_crack.orange.01" },
  { id: "boulder", group: "Distance", label: "Rocher", kind: "projectile", file: "jb2a.boulder.toss.02.01.stone.brown", impact: "jb2a.impact.ground_crack.orange.01", impactScale: 2 },
  { id: "bomb", group: "Distance", label: "Bombe", kind: "projectile", file: "jb2a.throwable.throw.bomb.01.black", impact: "jb2a.explosion.01.orange", impactScale: 2.5 },

  // --- Sorts --------------------------------------------------------------
  { id: "fire-bolt", group: "Sorts", label: "Trait de feu", kind: "projectile", file: "jb2a.fire_bolt.orange", cast: "jb2a.cast_generic.fire.01.orange", impact: "jb2a.impact.fire.01.orange" },
  { id: "ray-of-frost", group: "Sorts", label: "Rayon de givre", kind: "projectile", file: "jb2a.ray_of_frost.blue", cast: "jb2a.cast_generic.02.blue", impact: "jb2a.impact.frost.white.01" },
  { id: "ice-shard", group: "Sorts", label: "Éclat de glace", kind: "projectile", file: "jb2a.spell_projectile.ice_shard.blue", impact: "jb2a.impact.frost.white.01" },
  { id: "eldritch-blast", group: "Sorts", label: "Décharge occulte", kind: "projectile", file: "jb2a.eldritch_blast.purple", impact: "jb2a.impact.011.blue" },
  { id: "magic-missile", group: "Sorts", label: "Projectiles magiques (×3)", kind: "projectile", file: "jb2a.magic_missile.purple", count: 3, impact: "jb2a.impact.011.blue" },
  { id: "scorching-ray", group: "Sorts", label: "Rayon ardent (×3)", kind: "projectile", file: "jb2a.scorching_ray.01.orange", count: 3, impact: "jb2a.impact.fire.01.orange" },
  { id: "guiding-bolt", group: "Sorts", label: "Éclair traçant", kind: "projectile", file: "jb2a.guiding_bolt.01.blueyellow", cast: "jb2a.cast_generic.01.yellow", impact: "jb2a.impact.006.yellow" },
  { id: "witch-bolt", group: "Sorts", label: "Maléfice électrique", kind: "projectile", file: "jb2a.witch_bolt.blue", impact: "jb2a.impact.011.blue" },
  { id: "chain-lightning", group: "Sorts", label: "Éclair", kind: "projectile", file: "jb2a.chain_lightning.primary.blue", impact: "jb2a.impact.011.blue" },
  { id: "energy-beam", group: "Sorts", label: "Rayon d'énergie", kind: "projectile", file: "jb2a.energy_beam.normal.bluepink.02", impact: "jb2a.impact.011.blue" },
  { id: "disintegrate", group: "Sorts", label: "Désintégration", kind: "projectile", file: "jb2a.disintegrate.green", impact: "jb2a.impact.004.blue" },
  { id: "fireball", group: "Sorts", label: "Boule de feu", kind: "projectile", file: "jb2a.fireball.beam.orange", impact: "jb2a.fireball.explosion.orange", impactScale: 4 },
  { id: "sacred-flame", group: "Sorts", label: "Flamme sacrée", kind: "onTarget", file: "jb2a.sacred_flame.target.yellow", cast: "jb2a.sacred_flame.source.yellow", scale: 2 },
  { id: "toll-the-dead", group: "Sorts", label: "Glas", kind: "onTarget", file: "jb2a.toll_the_dead.green.complete", scale: 2.5 },
  { id: "divine-smite", group: "Sorts", label: "Châtiment divin", kind: "onTarget", file: "jb2a.divine_smite.target.blueyellow", cast: "jb2a.divine_smite.caster.blueyellow", scale: 2 },

  // Patreon
  { id: "lightning-bolt", group: "Sorts", label: "Éclair (ligne)", kind: "projectile", file: "jb2a.lightning_bolt.narrow.blue", cast: "jb2a.cast_generic.02.blue", impact: "jb2a.impact.011.blue" },
  { id: "breath-fire", group: "Sorts", label: "Souffle de feu", kind: "projectile", file: "jb2a.breath_weapons.fire.cone.orange.01", impact: "jb2a.impact.fire.01.orange" },
  { id: "cone-of-cold", group: "Sorts", label: "Cône de froid", kind: "projectile", file: "jb2a.cone_of_cold.blue", impact: "jb2a.impact.frost.white.01" },
  { id: "skull", group: "Sorts", label: "Crâne maudit", kind: "projectile", file: "jb2a.spell_projectile.skull.pinkpurple", impact: "jb2a.impact.011.blue" },
  { id: "lightning-strike", group: "Sorts", label: "Foudre", kind: "onTarget", file: "jb2a.lightning_strike.blue", scale: 2.5 },
  { id: "shatter", group: "Sorts", label: "Fracassement", kind: "onTarget", file: "jb2a.shatter.purple", scale: 3 },
  { id: "ice-spikes", group: "Sorts", label: "Pics de glace", kind: "onTarget", file: "jb2a.ice_spikes.radial.burst.blue", scale: 2 },
  { id: "explosion", group: "Sorts", label: "Explosion", kind: "onTarget", file: "jb2a.explosion.01.orange", scale: 2.5 },

  // --- Armes à feu ---------------------------------------------------------
  { id: "bullet", group: "Armes à feu", label: "Pistolet", kind: "projectile", file: "jb2a.bullet.01.orange", impact: "jb2a.impact.009.orange" },
  { id: "rifle", group: "Armes à feu", label: "Fusil", kind: "projectile", file: "jb2a.bullet.02.orange", impact: "jb2a.impact.009.orange", impactScale: 1.6 },
  { id: "sniper", group: "Armes à feu", label: "Tir de précision", kind: "projectile", file: "jb2a.bullet.Snipe.orange", impact: "jb2a.impact.009.orange", impactScale: 1.8 },
  { id: "burst-fire", group: "Armes à feu", label: "Rafale (×3)", kind: "projectile", file: "jb2a.bullet.01.orange", count: 3, impact: "jb2a.impact.009.orange" },
  { id: "blunderbuss", group: "Armes à feu", label: "Tromblon (dispersion ×5)", kind: "projectile", file: "jb2a.bullet.03.orange", count: 5, spread: true, impact: "jb2a.impact.009.orange" },
  { id: "plasma-shot", group: "Armes à feu", label: "Tir de plasma", kind: "projectile", file: "jb2a.bullet.02.blue", impact: "jb2a.impact.011.blue", impactScale: 1.6 },

  // --- Explosions ----------------------------------------------------------
  { id: "explosion-fire", group: "Explosions", label: "Explosion de feu", kind: "onTarget", file: "jb2a.explosion.04.orange", scale: 3 },
  { id: "explosion-frost", group: "Explosions", label: "Explosion de givre", kind: "onTarget", file: "jb2a.explosion.05.bluewhite", scale: 3 },
  { id: "explosion-lightning", group: "Explosions", label: "Explosion de foudre", kind: "onTarget", file: "jb2a.explosion.03.bluewhite", scale: 3 },
  { id: "explosion-necrotic", group: "Explosions", label: "Explosion nécrotique", kind: "onTarget", file: "jb2a.explosion.04.dark_purple", scale: 3 },
  { id: "explosion-acid", group: "Explosions", label: "Explosion d'acide", kind: "onTarget", file: "jb2a.explosion.08.green", scale: 3 },
  { id: "explosion-arcane", group: "Explosions", label: "Explosion arcanique", kind: "onTarget", file: "jb2a.explosion.03.purplepink", scale: 3 },
  { id: "explosion-big", group: "Explosions", label: "Grande explosion", kind: "onTarget", file: "jb2a.explosion.08.1200.orange", scale: 5 },
  { id: "grenade", group: "Explosions", label: "Grenade", kind: "projectile", file: "jb2a.throwable.throw.bomb.01.black", impact: "jb2a.explosion.shrapnel.grenade.03.orange", impactScale: 3 },
  { id: "flask", group: "Explosions", label: "Fiole qui éclate", kind: "onTarget", file: "jb2a.explosion.side_fracture.flask", scale: 2 },

  // --- Auras (restent accrochées au token, permanentes par défaut) ---------
  { id: "aura-bless", group: "Auras", label: "Bénédiction", kind: "aura", file: "jb2a.bless.400px.loop.yellow", scale: 1.8, below: true },
  { id: "aura-holy", group: "Auras", label: "Aura sacrée", kind: "aura", file: "jb2a.spirit_guardians.blueyellow.ring", scale: 3.5, below: true },
  { id: "aura-dark", group: "Auras", label: "Aura sombre", kind: "aura", file: "jb2a.spirit_guardians.dark_black.ring", scale: 3.5, below: true },
  { id: "aura-fire", group: "Auras", label: "Cercle de feu", kind: "aura", file: "jb2a.fire_ring.500px.red", scale: 2.6, below: true },
  { id: "aura-flames", group: "Auras", label: "Corps en flammes", kind: "aura", file: "jb2a.flames.04.loop.orange", scale: 1.4 },
  { id: "aura-cold", group: "Auras", label: "Aura de givre", kind: "aura", file: "jb2a.aura_themed.01.orbit.loop.cold.01.blue", scale: 2.2 },
  { id: "aura-nature", group: "Auras", label: "Aura de nature", kind: "aura", file: "jb2a.aura_themed.01.orbit.loop.nature.01.green", scale: 2.2 },
  { id: "aura-electric", group: "Auras", label: "Électricité statique", kind: "aura", file: "jb2a.static_electricity.01.blue", scale: 1.4 },
  { id: "aura-energy", group: "Auras", label: "Champ d'énergie", kind: "aura", file: "jb2a.energy_field.01.blue", scale: 2 },
  { id: "aura-shield", group: "Auras", label: "Bouclier magique", kind: "aura", file: "jb2a.shield.01.loop.blue", scale: 1.7 },
  { id: "aura-runes", group: "Auras", label: "Runes protectrices", kind: "aura", file: "jb2a.ward.rune.yellow", scale: 2.2, below: true },
  { id: "aura-arcane", group: "Auras", label: "Runes arcaniques", kind: "aura", file: "jb2a.markers.runes.blue", scale: 1.8, below: true },
  { id: "aura-orbs", group: "Auras", label: "Lumières dansantes", kind: "aura", file: "jb2a.dancing_light.blueteal", scale: 1 },
  { id: "aura-regen", group: "Auras", label: "Régénération", kind: "aura", file: "jb2a.healing_generic.loop.greenorange", scale: 1.6 },

  // --- Soins --------------------------------------------------------------
  { id: "cure-wounds", group: "Soins", label: "Soin des blessures", kind: "heal", file: "jb2a.cure_wounds.400px.blue", scale: 1.8 },
  { id: "healing", group: "Soins", label: "Soin (vert)", kind: "heal", file: "jb2a.healing_generic.400px.green", scale: 1.8 },
  { id: "healing-burst", group: "Soins", label: "Explosion de soin", kind: "heal", file: "jb2a.healing_generic.burst.greenorange", scale: 2 }
];

/** Effets communs aux états de résultat. */
export const RESULT_FX = {
  critText: "jb2a.ui.critical.red",
  missText: "jb2a.ui.miss.white",
  critGround: "jb2a.impact.ground_crack.orange.02",
  block: "jb2a.shield.01.complete.01.blue",
  blockImpact: "jb2a.impact.012.blue"
};

/**
 * Animations persistantes liées aux états de base de Foundry (identifiants de CONFIG.statusEffects).
 * Elles démarrent quand l'état est posé sur un token et s'arrêtent quand il est retiré.
 * Modifiables dans les réglages du module (« États animés ») ; une entrée vide = pas d'animation.
 *   file : entrée Sequencer · scale : taille relative au token · below : sous le token
 *   offsetY : décalage vertical en cases (négatif = au-dessus de la tête) · opacity : 0 à 1
 */
export const STATUS_FX = {
  poison: { file: "jb2a.markers.poison.dark_green", scale: 1.3 },
  burning: { file: "jb2a.flames.04.loop.orange", scale: 1.3 },
  bleeding: { file: "jb2a.markers.drop.red", scale: 1.3 },
  frozen: { file: "jb2a.aura_themed.01.orbit.loop.cold.01.blue", scale: 1.6 },
  shock: { file: "jb2a.static_electricity.03.blue", scale: 1.2 },
  corrode: { file: "jb2a.markers.drop.dark_green", scale: 1.3 },
  disease: { file: "jb2a.markers.smoke.ring.loop.green", scale: 1.4 },
  curse: { file: "jb2a.markers.skull.purple", scale: 1.3 },
  degen: { file: "jb2a.markers.skull.dark_red", scale: 1.3 },
  regen: { file: "jb2a.healing_generic.loop.greenorange", scale: 1.5 },
  stun: { file: "jb2a.dizzy_stars.400px.yellow", scale: 0.9, offsetY: -0.45 },
  sleep: { file: "jb2a.sleep.symbol.blue", scale: 0.8, offsetY: -0.5 },
  fear: { file: "jb2a.markers.fear.dark_purple", scale: 1.3 },
  silence: { file: "jb2a.markers.mute.blue", scale: 1.2 },
  paralysis: { file: "jb2a.markers.chain.diamond.loop.01.purple", scale: 1.4 },
  restrain: { file: "jb2a.markers.chain.diamond.loop.01.grey", scale: 1.4 },
  bless: { file: "jb2a.bless.400px.loop.yellow", scale: 1.6, below: true },
  fireShield: { file: "jb2a.shield.01.loop.red", scale: 1.6 },
  coldShield: { file: "jb2a.shield.01.loop.blue", scale: 1.6 },
  magicShield: { file: "jb2a.shield.01.loop.purple", scale: 1.6 },
  holyShield: { file: "jb2a.shield.01.loop.yellow", scale: 1.6 }
};
