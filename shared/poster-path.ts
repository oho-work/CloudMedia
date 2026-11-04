export function localPosterPath(value: string): string {
  const match = /^\/media\/posters\/[a-f0-9]{64}\.(?:jpg|png|webp|avif|gif)$/.exec(value);
  return match?.[0] === value ? value : '';
}
