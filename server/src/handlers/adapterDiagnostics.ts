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
import {
  aggregateContextDiagnostics,
  MAX_AGGREGATED_DIAGNOSTIC_CONTEXTS,
  type CompilerDiagnosticProvenance,
  type ContextDiagnosticFinding,
  type DiagnosticShaderContext,
} from '../workspace/diagnosticAggregation';

const SUPPORTED_ASSET_URI = /\.(?:shader|compute)(?:$|[?#])/i;
const PROFILE_DISCOVERY_KEY = '\u0000known-compile-profiles';

interface SavedAttempt {
  readonly uri: string;
  readonly openId: number;
  readonly version: number;
  readonly contentHash: string;
}

interface PublishedProfileGroup {
  readonly findings: readonly ContextDiagnosticFinding[];
}

interface PublishedAdapterDiagnostics extends SavedAttempt {
  readonly groups: Map<string, PublishedProfileGroup>;
}

interface PublishedProfileStatuses extends SavedAttempt {
  readonly statuses: Map<string, CompileProfileRunStatus>;
  knownContextCount: number;
  omittedContextCount: number;
  aggregateKnownContexts: boolean;
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

function compilerDiagnosticContext(
  uri: string,
  profile: CompileProfile,
  completed: boolean,
): DiagnosticShaderContext {
  const scopedReason = 'compiler-message-not-context-scoped';
  const profileReason = completed
    ? undefined
    : 'compiler-profile-not-completed';
  return {
    id: `compiler-profile:${compileProfileKey(profile)}`,
    shader: { status: 'verified', value: { uri } },
    pass: { status: 'unverified', reason: scopedReason },
    stage: { status: 'unverified', reason: scopedReason },
    includePoint: { status: 'unverified', reason: scopedReason },
    keywords: { status: 'unverified', reason: scopedReason },
    platform: profileReason
      ? { status: 'unverified', reason: profileReason }
      : { status: 'verified', value: profile.platform },
    graphicsApi: profileReason
      ? { status: 'unverified', reason: profileReason }
      : { status: 'verified', value: profile.graphicsApi },
    profile: { status: 'verified', value: { ...profile } },
  };
}

function compilerProvenance(
  diagnostic: ProfiledAdapterDiagnostic,
): CompilerDiagnosticProvenance {
  return {
    kind: 'compiler',
    profile: { ...diagnostic.profile },
    shaderMessage: { ...diagnostic.shaderMessage },
    envelope: {
      ...diagnostic.provenance,
      sourceRevision: { ...diagnostic.provenance.sourceRevision },
    },
  };
}

function unverifiedProfileReason(status: CompileProfileRunStatus): string {
  switch (status.status) {
    case 'running':
      return 'compiler-analysis-running';
    case 'profile-not-supported':
      return 'compiler-profile-not-supported';
    case 'adapter-unavailable':
      return `compiler-${status.reason}`;
    case 'completed':
      return 'compiler-analysis-completed';
  }
}

/**
 * Maintain compiler-verified diagnostics for exact saved document attempts.
 * Auto runs an explicitly capped Adapter-discovered profile set; an explicit
 * selection can add one profile. Completed findings are grouped without
 * collapsing Unity message details or provenance.
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
  const requestControllers = new Map<string, Map<string, AbortController>>();
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
    const controllers = requestControllers.get(key);
    if (controllers) {
      for (const controller of controllers.values()) controller.abort();
      requestControllers.delete(key);
    }
  };

  const replaceController = (key: string, requestKey: string): AbortController => {
    let controllers = requestControllers.get(key);
    if (!controllers) {
      controllers = new Map();
      requestControllers.set(key, controllers);
    }
    controllers.get(requestKey)?.abort();
    const controller = new AbortController();
    controllers.set(requestKey, controller);
    return controller;
  };

  const releaseController = (
    key: string,
    requestKey: string,
    controller: AbortController,
  ): void => {
    const controllers = requestControllers.get(key);
    if (controllers?.get(requestKey) !== controller) return;
    controllers.delete(requestKey);
    if (controllers.size === 0) requestControllers.delete(key);
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
      knownContextCount: 0,
      omittedContextCount: 0,
      aggregateKnownContexts: false,
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

  const refreshProfile = (
    document: IndexedDocumentSnapshot,
    profile: CompileProfile,
  ): void => {
    if (!SUPPORTED_ASSET_URI.test(document.uri)) return;
    const key = uriKey(document.uri);
    const attempt = ensureAttempt(document);
    const requestedProfile = { ...profile };
    const profileKey = compileProfileKey(requestedProfile);
    const generation = nextGeneration(key, profileKey);
    const controller = replaceController(key, profileKey);
    statusesForAttempt(key, attempt).statuses.set(profileKey, {
      status: 'running',
      profile: requestedProfile,
    });
    if (removeProfileGroup(key, profileKey)) publishChange();

    void registry.shaderMessagesFor(
      document.uri,
      attempt.contentHash,
      requestedProfile,
      controller.signal,
    ).then((result) => {
      if (!isCurrentGeneration(key, profileKey, generation)) return;
      const current = documents.snapshot(document.uri);
      const saved = savedAttempts.get(key);
      if (!current || !saved || saved !== attempt || !sameAttempt(current, attempt)) return;

      statusesForAttempt(key, attempt).statuses.set(profileKey, result);
      if (result.status !== 'completed') {
        const hasOtherPublishedProfiles = (published.get(key)?.groups.size ?? 0) > 0;
        if (removeProfileGroup(key, profileKey) || hasOtherPublishedProfiles) {
          publishChange();
        }
        return;
      }

      let publication = published.get(key);
      if (!publication || !sameSavedAttempt(publication, attempt)) {
        publication = { ...attempt, groups: new Map() };
        published.set(key, publication);
      }
      publication.groups.set(profileKey, {
        findings: result.diagnostics.map((diagnostic) => ({
          diagnostic: adapterDiagnosticToLsp(diagnostic, current.text),
          provenance: compilerProvenance(diagnostic),
        })),
      });
      publishChange();
    }).catch((error: unknown) => reportFailure(document.uri, error))
      .finally(() => releaseController(key, profileKey, controller));
  };

  const refreshKnownProfiles = (document: IndexedDocumentSnapshot): void => {
    if (!SUPPORTED_ASSET_URI.test(document.uri)) return;
    const key = uriKey(document.uri);
    const attempt = ensureAttempt(document);
    const generation = nextGeneration(key, PROFILE_DISCOVERY_KEY);
    const controller = replaceController(key, PROFILE_DISCOVERY_KEY);
    void registry.compileProfiles(controller.signal).then((discovery) => {
      if (!isCurrentGeneration(key, PROFILE_DISCOVERY_KEY, generation)) return;
      const current = documents.snapshot(document.uri);
      const saved = savedAttempts.get(key);
      if (!current || !saved || saved !== attempt || !sameAttempt(current, attempt)) return;
      if (discovery.status !== 'available') return;

      const statuses = statusesForAttempt(key, attempt);
      statuses.aggregateKnownContexts = true;
      const profiles = discovery.profiles.slice(
        0,
        MAX_AGGREGATED_DIAGNOSTIC_CONTEXTS,
      );
      statuses.knownContextCount = discovery.profiles.length;
      statuses.omittedContextCount = discovery.profiles.length - profiles.length;
      for (const profile of profiles) refreshProfile(current, profile);
    }).catch((error: unknown) => reportFailure(document.uri, error))
      .finally(() => releaseController(key, PROFILE_DISCOVERY_KEY, controller));
  };

  const refresh = (
    document: IndexedDocumentSnapshot,
    profile: CompileProfile | undefined = selectedProfile,
  ): void => {
    if (profile) {
      refreshProfile(document, profile);
    } else {
      refreshKnownProfiles(document);
    }
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
        const statusPublication = statusesForAttempt(key, attempt);
        statusPublication.knownContextCount = profiles.length;
        statusPublication.omittedContextCount = 0;
        for (const profile of profiles) {
          statusPublication.statuses.set(
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
      const raw = [...result.groups.values()].flatMap((group) => (
        group.findings.map(({ diagnostic }) => diagnostic)
      ));
      const statuses = profileStatuses.get(uriKey(document.uri));
      if (!statuses || !sameAttempt(document, statuses)) return raw;
      const knownContextCount = Math.max(
        statuses.knownContextCount,
        statuses.statuses.size,
      );
      if (
        !statuses.aggregateKnownContexts
        && statuses.statuses.size === 1
        && [...statuses.statuses.values()][0]?.status === 'completed'
        && knownContextCount === 1
        && statuses.omittedContextCount === 0
      ) return raw;

      const analyses = [...statuses.statuses.entries()].map(([profileKey, status]) => {
        const profile = statusProfile(status);
        const context = compilerDiagnosticContext(
          document.uri,
          profile,
          status.status === 'completed',
        );
        if (status.status !== 'completed') {
          return {
            status: 'unverified' as const,
            context,
            reason: unverifiedProfileReason(status),
          };
        }
        return {
          status: 'analyzed' as const,
          context,
          findings: result.groups.get(profileKey)?.findings ?? [],
        };
      });
      return aggregateContextDiagnostics({
        uri: document.uri,
        analyses,
        knownContextCount,
        omittedContextCount: statuses.omittedContextCount,
      });
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
      for (const attempt of [...savedAttempts.values()]) {
        const current = documents.snapshot(attempt.uri);
        if (current && sameAttempt(current, attempt)) {
          refresh(current);
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
