import {
  LiveDocumentTreeSession,
} from '../parser/hlsl/liveDocumentTreeSession';
import { uriKey } from '../uriKey';
import type { IndexedDocumentSnapshot } from './indexedWorkspace';

export interface LiveDocumentTreeSessionIdentity {
  readonly uriKey: string;
  readonly openId: number;
  readonly generation: number;
}

export type LiveDocumentTreeSessionFactory = (
  identity: LiveDocumentTreeSessionIdentity,
) => LiveDocumentTreeSession;

interface SessionEntry {
  readonly openId: number;
  readonly generation: number;
  readonly session: LiveDocumentTreeSession;
}

/** Workspace-owned live parser state, identified by canonical URI and open session. */
export class LiveDocumentTreeSessions {
  private readonly createSession: LiveDocumentTreeSessionFactory;
  private readonly entries = new Map<string, SessionEntry>();
  private nextGeneration = 1;
  private disposed = false;

  constructor(createSession: LiveDocumentTreeSessionFactory = () => new LiveDocumentTreeSession()) {
    this.createSession = createSession;
  }

  sessionFor(document: IndexedDocumentSnapshot): LiveDocumentTreeSession {
    if (this.disposed) throw new Error('Live document tree sessions were disposed');
    const key = uriKey(document.uri);
    const current = this.entries.get(key);
    if (current?.openId === document.openId) return current.session;
    current?.session.dispose();
    const generation = this.nextGeneration++;
    const entry: SessionEntry = {
      openId: document.openId,
      generation,
      session: this.createSession({
        uriKey: key,
        openId: document.openId,
        generation,
      }),
    };
    this.entries.set(key, entry);
    return entry.session;
  }

  close(uri: string, openId: number): void {
    const key = uriKey(uri);
    const current = this.entries.get(key);
    if (!current || current.openId !== openId) return;
    this.entries.delete(key);
    current.session.dispose();
  }

  retainOnly(documents: readonly IndexedDocumentSnapshot[]): void {
    const owned = new Map(documents.map((document) => [uriKey(document.uri), document.openId]));
    for (const [key, entry] of this.entries) {
      if (owned.get(key) === entry.openId) continue;
      this.entries.delete(key);
      entry.session.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.session.dispose();
    this.entries.clear();
  }
}
