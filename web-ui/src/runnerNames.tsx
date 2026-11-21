/** Names come from the site's private names.json; account IDs remain the keys. */
export type RunnerNames = Record<string, string>;

export function runnerName(id: string | null | undefined, names?: RunnerNames): string {
  return id && names && Object.hasOwn(names, id) ? names[id] : id || '—';
}

export function runnerLabel(id: string | null | undefined, names?: RunnerNames) {
  return <span title={id || undefined}>{runnerName(id, names)}</span>;
}
