import type { KeyBinding } from "../bindings";
import { normalizeKey } from "./keys";
import { COMMAND_BY_ID, COMMANDS } from "./registry";
import { evaluateWhen, type WhenContext } from "./when";

/** A binding in effect: a default one, or one from `keybindings.json`. */
export interface Binding {
  key: string;
  command: string;
  when?: string;
  user: boolean;
}

/** Defaults with the user's changes applied, in priority order (later wins). */
export function effectiveBindings(user: KeyBinding[]): Binding[] {
  const out: Binding[] = [];
  for (const c of COMMANDS) {
    for (const key of c.keys) {
      const k = normalizeKey(key);
      if (k) {
        out.push({ key: k, command: c.id, ...(c.when ? { when: c.when } : {}), user: false });
      }
    }
  }
  for (const b of user) {
    const key = normalizeKey(b.key);
    if (!key) {
      continue;
    }
    if (b.command.startsWith("-")) {
      // `-command` removes that command's bindings of the key (VS Code's convention).
      const id = b.command.slice(1);
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i]?.command === id && out[i]?.key === key) {
          out.splice(i, 1);
        }
      }
      continue;
    }
    // A user binding without `when` takes the command's default condition, so that a
    // rebound grid key still does not fire while typing.
    const when = b.when ?? COMMAND_BY_ID.get(b.command)?.when;
    out.push({ key, command: b.command, ...(when ? { when } : {}), user: true });
  }
  return out;
}

/** Keys bound to a command, best first (user bindings before defaults). */
export function keysFor(bindings: Binding[], command: string): string[] {
  const keys: string[] = [];
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (b?.command === command && !keys.includes(b.key)) {
      keys.push(b.key);
    }
  }
  return keys;
}

export type Match = { kind: "command"; command: string } | { kind: "prefix" } | null;

/**
 * Finds what a key sequence does. `available` tells whether a command can run now
 * (a component has registered a handler for it).
 */
export function matchKey(
  bindings: Binding[],
  sequence: string,
  ctx: WhenContext,
  available: (command: string) => boolean,
): Match {
  let prefix = false;
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (!b || !evaluateWhen(b.when, ctx) || !available(b.command)) {
      continue;
    }
    if (b.key === sequence) {
      return { kind: "command", command: b.command };
    }
    if (b.key.startsWith(`${sequence} `)) {
      prefix = true;
    }
  }
  return prefix ? { kind: "prefix" } : null;
}

/** Other commands bound to the same key whose conditions could overlap. */
export function conflicts(bindings: Binding[], key: string, command: string): Binding[] {
  const first = key.split(" ")[0];
  return bindings.filter(
    (b) =>
      b.command !== command &&
      (b.key === key ||
        // A chord blocks a single key that starts it, and the other way round.
        b.key.split(" ")[0] === key ||
        b.key === first),
  );
}

/**
 * The user file after binding `key` to `command`. `replace` removes the conflicting
 * bindings; otherwise both are kept (they should differ in their conditions).
 */
export function addBinding(
  user: KeyBinding[],
  bindings: Binding[],
  command: string,
  key: string,
  replace: boolean,
): KeyBinding[] {
  let next = [...user];
  if (replace) {
    for (const c of conflicts(bindings, key, command)) {
      next = removeBinding(next, c);
    }
  }
  next.push({ key, command });
  return next;
}

/** The user file after removing a binding (a user entry, or a default via `-command`). */
export function removeBinding(user: KeyBinding[], binding: Binding): KeyBinding[] {
  if (binding.user) {
    return user.filter(
      (b) => !(b.command === binding.command && normalizeKey(b.key) === binding.key),
    );
  }
  return [...user, { key: binding.key, command: `-${binding.command}` }];
}

/** The user file with every change to a command undone. */
export function resetCommand(user: KeyBinding[], command: string): KeyBinding[] {
  return user.filter((b) => b.command !== command && b.command !== `-${command}`);
}

/** Whether the user changed a command's keys. */
export function isCustomized(user: KeyBinding[], command: string): boolean {
  return user.some((b) => b.command === command || b.command === `-${command}`);
}
