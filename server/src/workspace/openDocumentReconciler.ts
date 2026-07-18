import { uriKey } from '../uriKey';
import type {
  IndexedDocumentSnapshot,
  OpenDocumentsProvider,
} from './indexedWorkspace';
import type {
  IndexedRevisionBuilder,
} from './indexedRevision';

export type DesiredDocumentState =
  | { readonly kind: 'open'; readonly document: IndexedDocumentSnapshot }
  | {
    readonly kind: 'closed';
    readonly uri: string;
    readonly openId: number;
    /** Explicit editor close; false when only Workspace ownership moved away. */
    readonly tombstone: boolean;
  };

export type ClosedDocumentState = Extract<DesiredDocumentState, { kind: 'closed' }>;

export interface ReconciledDocumentClose {
  readonly key: string;
  readonly close: ClosedDocumentState;
}

export type AppliedDocumentTransition =
  | { readonly kind: 'superseded' }
  | { readonly kind: 'open' }
  | { readonly kind: 'closed'; readonly reconciled: ReconciledDocumentClose };

interface CommittedDocumentView {
  hasCommittedDocument(document: IndexedDocumentSnapshot): boolean;
}

/**
 * Owns desired open-document identity and applies one desired state to any
 * isolated revision candidate. Publication timing remains the caller's policy.
 */
export class OpenDocumentReconciler {
  private readonly desiredDocuments = new Map<string, DesiredDocumentState>();
  private readonly closedDocumentOpenIds = new Map<string, number>();

  acceptDocument(document: IndexedDocumentSnapshot): boolean {
    const key = uriKey(document.uri);
    const closedOpenId = this.closedDocumentOpenIds.get(key);
    if (closedOpenId !== undefined && document.openId <= closedOpenId) return false;
    const current = this.desiredDocuments.get(key);
    if (current?.kind === 'open') {
      const previous = current.document;
      if (document.openId < previous.openId) return false;
      if (document.openId === previous.openId) {
        if (document.version < previous.version) return false;
        if (document.version === previous.version) {
          return document.languageId === previous.languageId
            && document.text === previous.text;
        }
      }
    } else if (current?.kind === 'closed') {
      if (document.openId < current.openId) return false;
      if (document.openId === current.openId && current.tombstone) return false;
    }
    this.desiredDocuments.set(key, { kind: 'open', document });
    return true;
  }

  acceptClose(uri: string, openId: number): boolean {
    const key = uriKey(uri);
    const current = this.desiredDocuments.get(key);
    if (current?.kind === 'closed' && current.openId === openId && !current.tombstone) {
      this.desiredDocuments.set(key, { kind: 'closed', uri, openId, tombstone: true });
      return true;
    }
    if (current?.kind !== 'open' || openId !== current.document.openId) return false;
    this.desiredDocuments.set(key, { kind: 'closed', uri, openId, tombstone: true });
    return true;
  }

  ownsSnapshot(
    document: IndexedDocumentSnapshot,
    provider: OpenDocumentsProvider | undefined,
  ): boolean {
    if (!provider) return true;
    for (const current of provider()) {
      if (sameDocumentAttempt(current, document)) return true;
    }
    return false;
  }

  captureProvider(
    provider: OpenDocumentsProvider | undefined,
    containsUri: (uri: string) => boolean,
    synchronizeOwnership: boolean,
  ): void {
    const ownedKeys = new Set<string>();
    for (const document of provider?.() ?? []) {
      if (!containsUri(document.uri)) continue;
      ownedKeys.add(uriKey(document.uri));
      this.acceptDocument(document);
    }

    if (!synchronizeOwnership || !provider) return;
    for (const [key, desired] of this.desiredDocuments) {
      if (desired.kind !== 'open' || ownedKeys.has(key)) continue;
      this.desiredDocuments.set(key, {
        kind: 'closed',
        uri: desired.document.uri,
        openId: desired.document.openId,
        tombstone: false,
      });
    }
  }

  desired(key: string): DesiredDocumentState | undefined {
    return this.desiredDocuments.get(key);
  }

  isCurrentDocument(document: IndexedDocumentSnapshot): boolean {
    const desired = this.desiredDocuments.get(uriKey(document.uri));
    return desired?.kind === 'open' && sameDocumentAttempt(desired.document, document);
  }

  isDesiredClose(uri: string, openId: number): boolean {
    const desired = this.desiredDocuments.get(uriKey(uri));
    return desired?.kind === 'closed' && desired.openId === openId;
  }

  needsReconcile(key: string, committed: CommittedDocumentView | undefined): boolean {
    const desired = this.desiredDocuments.get(key);
    if (!desired) return false;
    return desired.kind === 'open'
      ? !committed?.hasCommittedDocument(desired.document)
      : true;
  }

  keysNeedingReconcile(committed: CommittedDocumentView | undefined): string[] {
    return [...this.desiredDocuments.keys()].filter((key) => (
      this.needsReconcile(key, committed)
    ));
  }

  pendingTransitions(
    builder: IndexedRevisionBuilder,
    reconciledCloses: Map<string, ReconciledDocumentClose>,
  ): Array<readonly [string, DesiredDocumentState]> {
    for (const [key, reconciled] of reconciledCloses) {
      if (this.desiredDocuments.get(key) !== reconciled.close) {
        reconciledCloses.delete(key);
      }
    }
    return [...this.desiredDocuments.entries()].filter(([key, desired]) => (
      desired.kind === 'closed'
        ? reconciledCloses.get(key)?.close !== desired
        : !builder.hasCommittedDocument(desired.document)
    ));
  }

  async apply(
    builder: IndexedRevisionBuilder,
    key: string,
    desired: DesiredDocumentState,
    adapterIsCurrent: () => boolean,
  ): Promise<AppliedDocumentTransition> {
    const isCurrent = (): boolean => (
      adapterIsCurrent() && this.isCurrentState(desired)
    );
    if (!isCurrent()) return { kind: 'superseded' };

    try {
      if (desired.kind === 'closed') {
        if (!await builder.closeDocument(desired.uri, desired.openId, isCurrent)) {
          return { kind: 'superseded' };
        }
        return isCurrent()
          ? { kind: 'closed', reconciled: { key, close: desired } }
          : { kind: 'superseded' };
      }

      const candidate = await builder.prepareDocument(desired.document, isCurrent);
      if (!candidate || !builder.commitDocument(desired.document, candidate, isCurrent)) {
        return { kind: 'superseded' };
      }
      return isCurrent() ? { kind: 'open' } : { kind: 'superseded' };
    } catch (error) {
      if (!isCurrent()) return { kind: 'superseded' };
      throw error;
    }
  }

  commitPublishedCloses(closes: readonly ReconciledDocumentClose[]): void {
    for (const { key, close } of closes) {
      if (this.desiredDocuments.get(key) !== close) continue;
      this.desiredDocuments.delete(key);
      if (close.tombstone) {
        this.closedDocumentOpenIds.set(
          key,
          Math.max(this.closedDocumentOpenIds.get(key) ?? -1, close.openId),
        );
      }
    }
  }

  private isCurrentState(desired: DesiredDocumentState): boolean {
    if (desired.kind === 'closed') {
      return this.desiredDocuments.get(uriKey(desired.uri)) === desired;
    }
    return this.isCurrentDocument(desired.document);
  }
}

function sameDocumentAttempt(
  left: IndexedDocumentSnapshot,
  right: IndexedDocumentSnapshot,
): boolean {
  return uriKey(left.uri) === uriKey(right.uri)
    && left.openId === right.openId
    && left.version === right.version
    && left.languageId === right.languageId
    && left.text === right.text;
}
