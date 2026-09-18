export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
