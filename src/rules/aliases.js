/**
 * Aliases, which Merc 2.1 does not have: a character's own words for a command
 * or several, read before a line is interpreted and kept in the player file
 * (save.js), so they follow the character wherever it plays.
 *
 * `alias lx look;exits` makes `lx` run both. What is typed after the word goes
 * on the end of the alias's last command (`alias k kill`, then `k guard`), and
 * an alias may use others. `table` is the character's `aliases`: word to the
 * commands it stands for, ';' between them.
 */

import { oneArgument } from './handler.js';

/** How many a character may keep: they are stored with it, and a server stores them for everyone. */
export const MAX_ALIASES = 32;
/** How many commands one typed line may come to, however its aliases nest. */
export const MAX_COMMANDS = 20;
/** The two that manage aliases: an alias of either could shut a player out of his own list. */
const RESERVED = new Set(['alias', 'unalias']);

const commandsOf = (body) => body.split(';').map((c) => c.trim()).filter(Boolean);
const has = (table, word) => Object.hasOwn(table, word);

/**
 * The commands a typed line comes to: `{ lines }` (the line itself when its
 * first word is no alias), or `{ error }` -- an alias that comes round to
 * itself, however many others it goes through, or a line that comes to more
 * than MAX_COMMANDS. It is worked out whole before anything runs, so a line
 * that fails does none of its commands.
 */
export function expandAliases(table, line) {
  if (!table || !Object.keys(table).length) return { lines: [line] };
  const lines = [];
  const walk = (text, chain) => {
    // interp.c: a line that starts with a mark rather than a letter is a one-character command.
    const word = /^[a-z0-9]/i.test(text) ? oneArgument(text)[0] : '';
    if (RESERVED.has(word) || !has(table, word)) {
      lines.push(text);
      return lines.length > MAX_COMMANDS ? `That runs more than ${MAX_COMMANDS} commands; none was run.` : null;
    }
    if (chain.includes(word)) return `Alias loop: ${[...chain, word].join(' -> ')}.`;
    const parts = commandsOf(table[word]);
    if (!parts.length) return `The alias '${word}' has no commands.`;
    const rest = oneArgument(text)[1];
    if (rest) parts[parts.length - 1] += ` ${rest}`;
    for (const part of parts) {
      const error = walk(part, [...chain, word]);
      if (error) return error;
    }
    return null;
  };
  const error = walk(line.trim(), []);
  return error ? { error } : { lines };
}

/** `alias`: the list; `alias <word>`: that one; `alias <word> <commands>`: define it. Returns the lines to say. */
export function aliasCommand(table, word, body) {
  if (!word) {
    const names = Object.keys(table).sort();
    return names.length ? ['Your aliases:', ...names.map((name) => `${name.padEnd(12)} ${table[name]}`)] : ['You have no aliases defined.'];
  }
  if (!body) return [has(table, word) ? `${word} is aliased to '${table[word]}'.` : 'That alias is not defined.'];
  if (RESERVED.has(word)) return ['Sorry, that word is reserved.'];
  if (!/^[a-z0-9]+$/.test(word)) return ['An alias is one word, of letters and digits.'];
  if (!commandsOf(body).length) return ['An alias needs a command to run.'];
  if (!has(table, word) && Object.keys(table).length >= MAX_ALIASES) return [`You may have at most ${MAX_ALIASES} aliases.`];
  table[word] = body;
  return [`${word} is now aliased to '${body}'.`];
}

/** `unalias <word>`. Returns what to say. */
export function unaliasCommand(table, word) {
  if (!word) return 'Unalias which alias?';
  if (!has(table, word)) return 'That alias is not defined.';
  delete table[word];
  return `The alias '${word}' is gone.`;
}
