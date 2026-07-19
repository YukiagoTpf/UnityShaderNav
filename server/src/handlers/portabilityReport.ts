import type { Connection } from 'vscode-languageserver/node';
import {
  PORTABILITY_REPORT_REQUEST,
  PORTABILITY_TARGETS_REQUEST,
  type CompileProfileDiscovery,
  type CompileProfileRunResult,
  type PortabilityReport,
  type PortabilityReportParams,
  type PortabilityTarget,
  type PortabilityTargetsParams,
  type PortabilityTargetsResult,
} from '@unity-shader-nav/shared';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentSnapshot,
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { shaderSourceHash } from './adapterDiagnostics';
import { createDocumentRequestHandler } from './documentRequest';
import { portabilityTargetStore } from '../portability/targetStore';

interface PortabilityCompiler {
  compileProfiles(): Promise<CompileProfileDiscovery>;
  shaderMessagesFor(
    documentUri: string,
    contentHash: string,
    selectedProfile: Extract<PortabilityTarget, { kind: 'graphics-profile' }>['profile'],
  ): Promise<CompileProfileRunResult>;
}

function isPortabilityTarget(value: unknown): value is PortabilityTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const target = value as Partial<PortabilityTarget> & { readonly profile?: unknown };
  if (target.kind === 'render-pipeline') return target.pipeline === 'universal';
  if (target.kind !== 'graphics-profile') return false;
  if (typeof target.profile !== 'object' || target.profile === null) return false;
  const profile = target.profile as unknown as Record<string, unknown>;
  return ['name', 'platform', 'graphicsApi', 'capability'].every((key) => (
    typeof profile[key] === 'string' && profile[key].trim().length > 0
  ));
}

function pipelineDetail(report: PortabilityReport): string {
  const unity = report.environment.unityVersion ?? 'unknown';
  const urp = report.environment.renderPipelinePackage?.version ?? 'not resolved';
  return `Unity ${unity} · URP ${urp}`;
}

function documentAttemptIsCurrent(
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  document: IndexedDocumentSnapshot,
): boolean {
  const current = documents.snapshot(document.uri);
  return current?.openId === document.openId
    && current.version === document.version;
}

export function registerPortabilityReportHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  compiler: PortabilityCompiler,
  onTargetChanged: () => void,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onRequest(
    PORTABILITY_TARGETS_REQUEST,
    createDocumentRequestHandler<PortabilityTargetsParams, PortabilityTargetsResult>(
      documents,
      manager,
      suspender,
      {
        uri: (params) => params.textDocument.uri,
        neutral: () => ({ targets: [] }),
        resolve: async (_params, { document, workspace }) => {
          const target: PortabilityTarget = {
            kind: 'render-pipeline',
            pipeline: 'universal',
          };
          const [pipelineReport, discovery] = await Promise.all([
            workspace.portabilityReportAt({ document, target }),
            compiler.compileProfiles(),
          ]);
          const targets: PortabilityTargetsResult['targets'][number][] = [];
          if (pipelineReport) {
            targets.push({
              target,
              label: 'Universal Render Pipeline',
              detail: pipelineDetail(pipelineReport),
            });
          }
          if (discovery.status === 'available') {
            for (const profile of discovery.profiles) {
              targets.push({
                target: { kind: 'graphics-profile', profile: { ...profile } },
                label: profile.name,
                detail: `${profile.platform} · ${profile.graphicsApi}`,
              });
            }
          }
          return { targets };
        },
      },
    ),
  );

  connection.onRequest(
    PORTABILITY_REPORT_REQUEST,
    createDocumentRequestHandler<PortabilityReportParams, PortabilityReport | null>(
      documents,
      manager,
      suspender,
      {
        uri: (params) => params.textDocument.uri,
        neutral: () => null,
        resolve: async (params, { document, workspace }) => {
          if (!isPortabilityTarget(params.target)) return null;
          const compilerResult = params.target.kind === 'graphics-profile'
            ? await compiler.shaderMessagesFor(
              document.uri,
              shaderSourceHash(document.text),
              params.target.profile,
            )
            : undefined;
          if (!documentAttemptIsCurrent(documents, document)) return null;
          const report = await workspace.portabilityReportAt({
            document,
            target: params.target,
            ...(compilerResult ? { compilerResult } : {}),
          });
          if (!report || !documentAttemptIsCurrent(documents, document)) return null;
          portabilityTargetStore.set(document.uri, params.target);
          onTargetChanged();
          return report;
        },
      },
    ),
  );
}
