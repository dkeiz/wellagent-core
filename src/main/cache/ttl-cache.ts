// @ts-nocheck
class TtlCache {
  constructor({ max = 100, ttl = 300000 } = {}) {
    this.max = Math.max(1, Number(max) || 100);
    this.ttl = Math.max(1, Number(ttl) || 300000);
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttl });
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return this;
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { TtlCache };
