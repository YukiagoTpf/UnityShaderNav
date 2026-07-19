import { createHash } from 'node:crypto';
import {
  DiagnosticSeverity,
  type Connection,
  type Diagnostic,
} from 'vscode-languageserver/node';
import type {
  AdapterStatus,
  CompileProfile,
  CompileProfileDiscovery,
  CompileProfileRunStatus,
  ProfiledAdapterDiagnostic,
} from '@unity-shader-nav/shared';
import type { AdapterRegistry } from '../adapter/adapterRegistry';
import { uriKey } from '../uriKey';
import type { FileEvent } from '../workspace/workspace';
import type { IndexedDocumentSnapshot } from '../workspace/indexedWorkspace';
import type { RegisteredDocuments } from './documents';
import type { DiagnosticOverlay } from './diagnosticOverlay';

const SUPPORTED_ASSET_URI = /\.(?:shader|compute)(?:$|[?#])/i;

interface SavedAttempt {
  readonly uri: string;
  readonly openId: number;
  readonly version: number;
  readonly contentHash: string;
}

interface PublishedProfileGroup {
  readonly profile: CompileProfile;
  readonly diagnostics: readonly Diagnostic[];
}

interface PublishedAdapterDiagnostics extends SavedAttempt {
  readonly groups: Map<string, PublishedProfileGroup>;
}

interface PublishedProfileStatuses extends SavedAttempt {
  readonly statuses: Map<string, CompileProfileRunStatus>;
}

export interface AdapterDiagnosticOverlay extends DiagnosticOverlay {
  handleFileEvent(event: FileEvent): void;
  availableProfiles(): Promise<CompileProfileDiscovery>;
  selectProfile(profile: CompileProfile | null): void;
  profileStatusesFor(
    document: IndexedDocumentSnapshot,
  ): readonly CompileProfileRunStatus[];
}

export function shaderSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function sameAttempt(
  document: IndexedDocumentSnapshot | undefined,
  attempt: SavedAttempt,
): boolean {
  return !!document
    && document.openId === attempt.openId
    && document.version === attempt.version
    && shaderSourceHash(document.text) === attempt.contentHash;
}

function sameSavedAttempt(left: SavedAttempt, right: SavedAttempt): boolean {
  return left.openId === right.openId
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

function compileProfileKey(profile: CompileProfile): string {
  return [
    profile.name,
    profile.platform,
    profile.graphicsApi,
    profile.capability,
  ].join('\u0000');
}

function statusProfile(status: CompileProfileRunStatus): CompileProfile {
  return status.status === 'running' || status.status === 'completed'
    ? status.profile
    : status.requestedProfile;
}

function adapterDiagnosticToLsp(
  diagnostic: ProfiledAdapterDiagnostic,
  source: string,
): Diagnostic {
  const { profile, shaderMessage, provenance } = diagnostic;
  const sourceLines = source.split(/\r\n|\r|\n/);
  const reportedLine = shaderMessage.line ?? 1;
  const line = Math.min(
    Math.max(0, Number.isFinite(reportedLine) ? Math.trunc(reportedLine) - 1 : 0),
    Math.max(0, sourceLines.length - 1),
  );
  const details = shaderMessage.messageDetails
    ? `\n${shaderMessage.messageDetails}`
    : '';
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: sourceLines[line]?.length ?? 0 },
    },
    severity: shaderMessage.severity === 'error'
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning,
    source: `Unity Shader Compiler [${profile.name}] (Unity ${provenance.unityVersion}, ${profile.platform}, ${profile.graphicsApi})`,
    message: `${shaderMessage.message}${details}`,
    data: {
      kind: 'adapter-diagnostic',
      shaderMessage,
      provenance,
      profile,
    },
  };
}

/**
 * Maintain compiler-verified diagnostics for exact saved document attempts.
 * Each request runs one Adapter-discovered profile; completed groups coexist
 * so Problems can distinguish their compiler truth without collapsing Unity
 * message details or provenance.
 */
export function registerAdapterDiagnosticOverlay(
  connection: Connection,
  documents: RegisteredDocuments,
  registry: AdapterRegistry,
  initialProfile?: CompileProfile,
): AdapterDiagnosticOverlay {
  let selectedProfile = initialProfile ? { ...initialProfile } : undefined;
  const savedAttempts = new Map<string, SavedAttempt>();
  const published = new Map<string, PublishedAdapterDiagnostics>();
  const profileStatuses = new Map<string, PublishedProfileStatuses>();
  const requestGenerations = new Map<string, Map<string, number>>();
  const listeners = new Set<() => void>();

  const reportFailure = (uri: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(
      `[UnityShaderNav] Adapter diagnostics refresh failed for ${uri}: ${message}`,
    );
  };

  const publishChange = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const nextGeneration = (key: string, profileKey: string): number => {
    let generations = requestGenerations.get(key);
    if (!generations) {
      generations = new Map();
      requestGenerations.set(key, generations);
    }
    const generation = (generations.get(profileKey) ?? 0) + 1;
    generations.set(profileKey, generation);
    return generation;
  };

  const invalidateAll = (key: string): void => {
    const generations = requestGenerations.get(key);
    if (!generations) return;
    for (const [profileKey, generation] of generations) {
      generations.set(profileKey, generation + 1);
    }
  };

  const isCurrentGeneration = (
    key: string,
    profileKey: string,
    generation: number,
  ): boolean => requestGenerations.get(key)?.get(profileKey) === generation;

  const clearPublished = (key: string): boolean => published.delete(key);

  const ensureAttempt = (document: IndexedDocumentSnapshot): SavedAttempt => {
    const key = uriKey(document.uri);
    const candidate: SavedAttempt = {
      uri: document.uri,
      openId: document.openId,
      version: document.version,
      contentHash: shaderSourceHash(document.text),
    };
    const current = savedAttempts.get(key);
    if (current && sameSavedAttempt(current, candidate)) return current;

    invalidateAll(key);
    savedAttempts.set(key, candidate);
    profileStatuses.delete(key);
    if (clearPublished(key)) publishChange();
    return candidate;
  };

  const statusesForAttempt = (
    key: string,
    attempt: SavedAttempt,
  ): PublishedProfileStatuses => {
    const current = profileStatuses.get(key);
    if (current && sameSavedAttempt(current, attempt)) return current;
    const created: PublishedProfileStatuses = {
      ...attempt,
      statuses: new Map(),
    };
    profileStatuses.set(key, created);
    return created;
  };

  const removeProfileGroup = (key: string, profileKey: string): boolean => {
    const publication = published.get(key);
    if (!publication || !publication.groups.delete(profileKey)) return false;
    if (publication.groups.size === 0) published.delete(key);
    return true;
  };

  const refresh = (
    document: IndexedDocumentSnapshot,
    profile: CompileProfile | undefined = selectedProfile,
  ): void => {
    if (!SUPPORTED_ASSET_URI.test(document.uri) || !profile) return;
    const key = uriKey(document.uri);
    const attempt = ensureAttempt(document);
    const requestedProfile = { ...profile };
    const profileKey = compileProfileKey(requestedProfile);
    const generation = nextGeneration(key, profileKey);
    statusesForAttempt(key, attempt).statuses.set(profileKey, {
      status: 'running',
      profile: requestedProfile,
    });
    if (removeProfileGroup(key, profileKey)) publishChange();

    void registry.shaderMessagesFor(
      document.uri,
      attempt.contentHash,
      requestedProfile,
    ).then((result) => {
      if (!isCurrentGeneration(key, profileKey, generation)) return;
      const current = documents.snapshot(document.uri);
      const saved = savedAttempts.get(key);
      if (!current || !saved || saved !== attempt || !sameAttempt(current, attempt)) return;

      statusesForAttempt(key, attempt).statuses.set(profileKey, result);
      if (result.status !== 'completed') {
        if (removeProfileGroup(key, profileKey)) publishChange();
        return;
      }

      let publication = published.get(key);
      if (!publication || !sameSavedAttempt(publication, attempt)) {
        publication = { ...attempt, groups: new Map() };
        published.set(key, publication);
      }
      publication.groups.set(profileKey, {
        profile: result.profile,
        diagnostics: result.diagnostics.map((diagnostic) => (
          adapterDiagnosticToLsp(diagnostic, current.text)
        )),
      });
      publishChange();
    }).catch((error: unknown) => reportFailure(document.uri, error));
  };

  const clearAttempt = (uri: string, forgetSaved: boolean): void => {
    const key = uriKey(uri);
    invalidateAll(key);
    if (forgetSaved) savedAttempts.delete(key);
    profileStatuses.delete(key);
    if (clearPublished(key)) publishChange();
  };

  const handleStatusChange = (status: AdapterStatus): void => {
    const requestedProfiles = new Map<string, CompileProfile[]>();
    for (const [key, publication] of profileStatuses) {
      requestedProfiles.set(
        key,
        [...publication.statuses.values()].map(statusProfile),
      );
    }
    for (const key of new Set([
      ...savedAttempts.keys(),
      ...requestGenerations.keys(),
      ...published.keys(),
    ])) invalidateAll(key);

    const hadPublished = published.size > 0;
    published.clear();
    profileStatuses.clear();
    if (hadPublished) publishChange();
    if (status.mode === 'standalone') {
      for (const [key, attempt] of savedAttempts) {
        const profiles = requestedProfiles.get(key) ?? (
          selectedProfile ? [selectedProfile] : []
        );
        const statuses = statusesForAttempt(key, attempt).statuses;
        for (const profile of profiles) {
          statuses.set(
            compileProfileKey(profile),
            {
              status: 'adapter-unavailable',
              requestedProfile: { ...profile },
              reason: status.reason,
            },
          );
        }
      }
      return;
    }

    for (const attempt of [...savedAttempts.values()]) {
      const current = documents.snapshot(attempt.uri);
      if (current && sameAttempt(current, attempt)) refresh(current);
    }
  };

  documents.documents.onDidOpen(({ document }) => {
    const snapshot = documents.snapshot(document.uri);
    if (!snapshot || !SUPPORTED_ASSET_URI.test(snapshot.uri)) return;
    ensureAttempt(snapshot);
  });
  documents.documents.onDidChangeContent(({ document }) => {
    const key = uriKey(document.uri);
    const saved = savedAttempts.get(key);
    if (saved && sameAttempt(documents.snapshot(document.uri), saved)) return;
    clearAttempt(document.uri, true);
  });
  documents.documents.onDidSave(({ document }) => {
    const snapshot = documents.snapshot(document.uri);
    if (snapshot) refresh(snapshot);
  });
  documents.onDidCloseSnapshot((document) => {
    clearAttempt(document.uri, true);
  });
  registry.onDidChangeStatus(handleStatusChange);

  return {
    diagnosticsFor(document) {
      const result = published.get(uriKey(document.uri));
      if (!result || !sameAttempt(document, result)) return [];
      return [...result.groups.values()].flatMap((group) => group.diagnostics);
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    handleFileEvent(event) {
      if (event.type === 'deleted') clearAttempt(event.uri, true);
    },
    availableProfiles() {
      return registry.compileProfiles();
    },
    selectProfile(profile) {
      selectedProfile = profile ? { ...profile } : undefined;
      if (!selectedProfile) return;
      for (const attempt of [...savedAttempts.values()]) {
        const current = documents.snapshot(attempt.uri);
        if (current && sameAttempt(current, attempt)) {
          refresh(current, selectedProfile);
        }
      }
    },
    profileStatusesFor(document) {
      const result = profileStatuses.get(uriKey(document.uri));
      return result && sameAttempt(document, result)
        ? [...result.statuses.values()]
        : [];
    },
  };
}
