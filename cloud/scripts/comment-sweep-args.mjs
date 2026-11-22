export function threshold(flags, name, fallback) {
  const value = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}
