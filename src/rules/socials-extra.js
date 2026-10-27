/**
 * Socials Merc 2.1 does not have, written by hand. socials.js is generated
 * from interp.c's social_table and is overwritten by tools/gen-socials.mjs,
 * so nothing of ours can live there; interp.js reads this table after it, and
 * on a name clash Merc's row wins.
 *
 * Each row is Merc's: name, char_no_arg, others_no_arg, char_found,
 * others_found, vict_found, char_auto, others_auto (null: nothing is shown).
 */
export const EXTRA_SOCIALS = [
  ['rofl', 'You roll on the floor laughing.', '$n rolls on the floor laughing.',
    'You roll on the floor laughing at $N.', '$n rolls on the floor laughing at $N.', '$n rolls on the floor laughing at you.',
    'You roll on the floor laughing at yourself.', '$n rolls on the floor laughing at $mself.'],
];
