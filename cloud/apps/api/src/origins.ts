export function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const url = new URL(x);
      if (url.origin !== x.replace(/\/$/, '')) throw new Error(`Web origin must be a bare origin: ${x}`);
      return url.origin;
    });
}
