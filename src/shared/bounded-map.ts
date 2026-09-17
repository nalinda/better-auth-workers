// A Map that holds at most `capacity` entries: inserting a new key when
// full evicts the oldest (first inserted) one.
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly capacity: number;

  constructor(capacity: number) {
    super();
    this.capacity = capacity;
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.capacity) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}
