/**
 * Identifier generation.
 *
 * Kept out of `domain/` and `optimizer/` so that those layers stay deterministic:
 * IDs are produced by the UI/storage layers and passed in as data.
 */

let counter = 0;

/** Creates a short, collision-resistant identifier. */
export function createId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  const seq = counter.toString(36).padStart(3, '0');
  return `${prefix}_${time}${seq}${rand}`;
}
