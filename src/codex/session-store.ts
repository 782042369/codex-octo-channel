/** Persistent mapping from conversation key to Codex thread id.
 *
 * Stored as one JSON file under the state root, written atomically
 * (tmp + rename) so a crash mid-write never corrupts the map.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConversationKey } from "../conversation.js";

/** One persisted conversation → thread mapping. */
export interface StoredSession {
  /** Codex thread id used with `codex exec resume`. */
  threadId: string;
  /** Epoch ms of the last turn that touched this mapping. */
  updatedAt: number;
}

/** Shape of the on-disk session-map.json. */
interface StoreFile {
  sessions: Record<string, StoredSession>;
}

/**
 * Load and validate the store file from disk.
 * @param path - session-map.json location.
 * @returns Parsed store; empty when missing or invalid.
 */
function loadFile(path: string): StoreFile {
  if (!existsSync(path)) return { sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
    const sessions: Record<string, StoredSession> = {};
    for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
      if (typeof value?.threadId === "string" && value.threadId !== "") {
        sessions[key] = { threadId: value.threadId, updatedAt: value.updatedAt ?? 0 };
      }
    }
    return { sessions };
  } catch {
    return { sessions: {} };
  }
}

/**
 * Conversation → Codex thread registry with atomic persistence.
 */
export class SessionStore {
  private readonly sessions: Record<string, StoredSession>;
  private closed = false;

  /**
   * @param path - location of session-map.json.
   */
  constructor(private readonly path: string) {
    this.sessions = loadFile(path).sessions;
  }

  /**
   * Open the store, creating parent directories when needed.
   * @param path - location of session-map.json.
   * @returns The opened store.
   */
  static open(path: string): SessionStore {
    mkdirSync(dirname(path), { recursive: true });
    return new SessionStore(path);
  }

  /**
   * Look up the persisted thread id for one conversation.
   * @param key - conversation identity.
   * @returns The stored mapping, or undefined for fresh conversations.
   */
  get(key: ConversationKey): StoredSession | undefined {
    return this.sessions[key];
  }

  /**
   * Persist the thread id for one conversation and flush to disk.
   * @param key - conversation identity.
   * @param threadId - Codex thread id captured from `thread.started`.
   * @returns void.
   */
  set(key: ConversationKey, threadId: string): void {
    if (this.closed || threadId === "") return;
    this.sessions[key] = { threadId, updatedAt: Date.now() };
    this.flush();
  }

  /**
   * Forget one conversation so the next turn starts a fresh thread.
   * @param key - conversation identity.
   * @returns void.
   */
  reset(key: ConversationKey): void {
    if (this.closed) return;
    delete this.sessions[key];
    this.flush();
  }

  /**
   * Number of tracked conversations (diagnostics).
   * @returns Stored mapping count.
   */
  get size(): number {
    return Object.keys(this.sessions).length;
  }

  /**
   * Stop accepting updates. Kept for symmetry with other lifecycles;
   * every mutation already flushes synchronously.
   * @returns void.
   */
  close(): void {
    this.closed = true;
  }

  /**
   * Atomically write the current map to disk.
   * @returns void; failures are swallowed (state is advisory).
   */
  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = join(dirname(this.path), ".session-map.json.tmp");
      writeFileSync(tmp, JSON.stringify({ sessions: this.sessions }, null, 2));
      renameSync(tmp, this.path);
    } catch {
      // Persisted sessions are an optimization; losing one costs a fresh thread.
    }
  }
}
