/**
 * The rest of Merc 2.1, installed into a running game: game.js calls this
 * once with its internals (`k`), and each part adds what it ports to the
 * public `game` object and hooks into the pulses through `k.rules`.
 */

import { installWorld } from './world.js';
import { installObjects } from './actobj.js';
import { installMove } from './actmove.js';
import { installSkills } from './skills.js';
import { installSpecials } from './specials.js';
import { installInterp } from './interp.js';

export function installRules(k) {
  // The zone's bodies, whichever zone is drawn when it is called.
  k.perform = (slot, clip, options) => (k.actors && k.actors.perform ? k.actors.perform(slot, clip, options) : null);
  installWorld(k);
  installObjects(k);
  installMove(k);
  installSkills(k);
  installSpecials(k);
  installInterp(k);
}
