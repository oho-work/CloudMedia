/** Only unambiguous numeric labels share an episode across playback lines. */
export function episodeKey(label: string): string {
  const normalized = label.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
  const numeric = /^(?:第0*(\d+)集|ep0*(\d+)|0*(\d+))$/.exec(normalized);
  if (numeric) return `episode:${Number(numeric[1] || numeric[2] || numeric[3])}`;
  // Keep seasons, part suffixes, trailers, extras and feature labels distinct.
  return `label:${normalized}`;
}
