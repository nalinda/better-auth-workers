// A warning logged at most once per isolate. For deprecations and other
// misconfigurations reached on every request (the Hyperdrive path builds a
// fresh instance per request), so a busy Worker is not flooded.
export function warnOnce(message: string): () => void {
  let hasWarned = false;
  return () => {
    if (hasWarned) return;
    hasWarned = true;
    console.warn(message);
  };
}
