import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const STORE_SCHEMA_VERSION = 1;
const LOCK_RETRY_MS = 8;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function emptyState() {
  return { schemaVersion: STORE_SCHEMA_VERSION, revision: 0, records: {} };
}

function recordKey(kind, id) {
  return `${kind}:${id}`;
}

function validateState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OAuth store is invalid');
  }
  if (
    value.schemaVersion !== STORE_SCHEMA_VERSION
    || !Number.isInteger(value.revision)
    || value.revision < 0
    || value.records === null
    || typeof value.records !== 'object'
    || Array.isArray(value.records)
  ) {
    throw new Error('OAuth store schema is invalid');
  }
  return value;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class DurableOAuthStore {
  #path;
  #lockPath;

  constructor(path) {
    if (!path || String(path).trim().length === 0) throw new Error('OAuth store path is required');
    this.#path = path;
    this.#lockPath = `${path}.lock`;
  }

  async initialize() {
    await mkdir(dirname(this.#path), { recursive: true });
    await this.#withExclusiveLock(async () => {
      try {
        await stat(this.#path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await this.#writeStateUnlocked(emptyState());
      }
    });
  }

  async #readStateUnlocked() {
    try {
      return validateState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #writeStateUnlocked(state) {
    const tempPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.#path);
      committed = true;
      try {
        const directory = await open(dirname(this.#path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
    } finally {
      if (!committed) await rm(tempPath, { force: true });
    }
  }

  async #assertLockIsRecoverable() {
    let raw;
    try {
      raw = await readFile(this.#lockPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const [pidText, createdText] = raw.trim().split(':');
    const ownerPid = Number(pidText);
    const createdAt = Number(createdText);
    if (
      !Number.isInteger(ownerPid)
      || ownerPid <= 0
      || !Number.isFinite(createdAt)
      || Date.now() - createdAt < STALE_LOCK_MS
    ) {
      return;
    }
    try {
      process.kill(ownerPid, 0);
      return;
    } catch (error) {
      if (error?.code === 'EPERM') return;
      if (error?.code !== 'ESRCH') throw error;
    }
    throw new Error(`stale OAuth store lock owned by dead PID ${ownerPid} requires explicit operator recovery`);
  }

  async #withExclusiveLock(work) {
    const startedAt = Date.now();
    let handle;
    while (handle === undefined) {
      try {
        handle = await open(this.#lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}:${Date.now()}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await this.#assertLockIsRecoverable();
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error('timed out acquiring durable OAuth store lock', { cause: error });
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await work();
    } finally {
      await handle.close();
      await rm(this.#lockPath, { force: true });
    }
  }

  async getRecord(kind, id) {
    const state = await this.#readStateUnlocked();
    const value = state.records[recordKey(kind, id)];
    return value === undefined ? undefined : structuredClone(value);
  }

  async compareAndSetRecord(input) {
    return this.#withExclusiveLock(async () => {
      const state = await this.#readStateUnlocked();
      const key = recordKey(input.kind, input.id);
      const current = state.records[key];
      if (
        (input.expectedRevision === null && current !== undefined)
        || (input.expectedRevision !== null && current?.revision !== input.expectedRevision)
      ) {
        return undefined;
      }
      const next = {
        schemaVersion: STORE_SCHEMA_VERSION,
        kind: input.kind,
        id: input.id,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? input.updatedAt,
        updatedAt: input.updatedAt,
        value: structuredClone(input.value),
      };
      state.records[key] = next;
      state.revision += 1;
      await this.#writeStateUnlocked(state);
      return structuredClone(next);
    });
  }

  async compareAndSetRecords(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    return this.#withExclusiveLock(async () => {
      const state = await this.#readStateUnlocked();
      const nextRecords = [];
      for (const input of inputs) {
        const key = recordKey(input.kind, input.id);
        const current = state.records[key];
        if (
          (input.expectedRevision === null && current !== undefined)
          || (input.expectedRevision !== null && current?.revision !== input.expectedRevision)
        ) {
          return undefined;
        }
        nextRecords.push({
          schemaVersion: STORE_SCHEMA_VERSION,
          kind: input.kind,
          id: input.id,
          revision: (current?.revision ?? 0) + 1,
          createdAt: current?.createdAt ?? input.updatedAt,
          updatedAt: input.updatedAt,
          value: structuredClone(input.value),
        });
      }
      for (const record of nextRecords) {
        state.records[recordKey(record.kind, record.id)] = record;
      }
      state.revision += nextRecords.length;
      await this.#writeStateUnlocked(state);
      return nextRecords.map((record) => structuredClone(record));
    });
  }
}
