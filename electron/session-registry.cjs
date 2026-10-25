'use strict';

// Owns admission, leases and invalidation; creating a connection is injected.
class SessionRegistry {
  constructor({ create, limit = 8, isProtected = () => false }) {
    this.create = create;
    this.limit = limit;
    this.isProtected = isProtected;
    this.entries = new Map();
    this.opening = new Map();
    this.versions = new Map();
    this.leases = new Map();
    this.admission = Promise.resolve();
  }

  touch(id) {
    const entry = this.entries.get(id);
    if (entry) { this.entries.delete(id); this.entries.set(id, entry); }
    return entry;
  }

  busy(entry) {
    return Boolean(this.leases.get(entry) || entry.session.activeTask || entry.session.inTransaction
      || entry.session.autocommit === false || this.isProtected(entry));
  }

  async dispose(entry) {
    try { await entry.session.close(); } catch { /* Best effort; close has its own deadline. */ }
  }

  open(id, options = {}) {
    const cached = this.entries.get(id);
    if (cached && !cached.session.dead && cached.session.connection) return Promise.resolve(this.touch(id));
    if (this.opening.has(id)) return this.opening.get(id);
    const version = this.versions.get(id) || 0;
    const stale = () => version !== (this.versions.get(id) || 0);
    const canceled = () => Object.assign(new Error('Yêu cầu kết nối đã hết hiệu lực.'), { code: 'SESSION_OPEN_CANCELED' });
    const pending = (async () => {
      if (cached) { this.entries.delete(id); await this.dispose(cached); }
      const entry = await this.create(id, options);
      try {
        const admit = this.admission.catch(() => {}).then(async () => {
          if (stale()) throw canceled();
          while (this.entries.size >= this.limit) {
            const candidate = [...this.entries].find(([, value]) => !this.busy(value));
            if (!candidate) throw Object.assign(new Error('Các phiên kết nối đều đang được sử dụng. Hãy đợi tác vụ hoàn tất.'), { code: 'SESSION_BUSY' });
            this.entries.delete(candidate[0]);
            await this.dispose(candidate[1]);
            if (stale()) throw canceled();
          }
          this.entries.set(id, entry);
          return entry;
        });
        this.admission = admit;
        return await admit;
      } catch (error) { await this.dispose(entry); throw error; }
    })();
    this.opening.set(id, pending);
    pending.finally(() => { if (this.opening.get(id) === pending) this.opening.delete(id); }).catch(() => {});
    return pending;
  }

  acquire(entry) {
    this.leases.set(entry, (this.leases.get(entry) || 0) + 1);
    this.touch(entry.profileId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.leases.get(entry) || 1) - 1;
      if (remaining) this.leases.set(entry, remaining);
      else this.leases.delete(entry);
    };
  }

  async reopen(entry, options = {}) {
    const id = entry.profileId;
    const version = this.versions.get(id) || 0;
    const canceled = () => Object.assign(new Error('Yêu cầu kết nối đã hết hiệu lực.'), { code: 'SESSION_OPEN_CANCELED' });
    if (!await this.close(id, entry)) throw canceled();
    // Explicit disconnect or another open while disposal awaited wins over retry.
    if ((this.versions.get(id) || 0) !== version + 1 || this.entries.has(id) || this.opening.has(id)) throw canceled();
    return this.open(id, options);
  }

  async close(id, expected) {
    if (expected && this.entries.get(id) !== expected) return false;
    this.versions.set(id, (this.versions.get(id) || 0) + 1);
    this.opening.delete(id);
    const entry = this.entries.get(id);
    this.entries.delete(id);
    if (entry) await this.dispose(entry);
    return true;
  }

  async closeAll() {
    const ids = new Set([...this.entries.keys(), ...this.opening.keys()]);
    await Promise.all([...ids].map((id) => this.close(id)));
  }
}

module.exports = { SessionRegistry };
