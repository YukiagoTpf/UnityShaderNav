import type {
  Connection,
  DefinitionParams,
  Location,
  LocationLink,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import { resolveInclude } from '../include';
import {
  collectVisibleUriKeys,
  findPropertyCandidatesForName,
  memberAccessAt,
  propertyAt,
  resolveDefinition,
  resolveDefinitionSymbols,
  resolveMember,
  wordAt,
} from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { scanIncludes } from '../parser/include/lineScanner';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import type { WorkspaceManager } from '../workspace';

function logDefinitionTrace(
  connection: Connection,
  enabled: boolean,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!enabled) return;
  connection.console.log(`[UnityShaderNav][definition-trace] ${event} ${JSON.stringify(data)}`);
}

export function registerDefinitionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | Location[] | null> => {
    const resolveRequest = async (): Promise<LocationLink[] | Location[] | null> => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;
      const traceEnabled = workspace.settings?.debug?.definitionTrace === true;
      const trace = (event: string, data: Record<string, unknown>) =>
        logDefinitionTrace(connection, traceEnabled, event, data);
      trace('request', {
        uri: params.textDocument.uri,
        position: params.position,
        languageId: doc.languageId,
      });

      const fullText = doc.getText();
      const include = scanIncludes(fullText).find((candidate) =>
        candidate.line === params.position.line
        && params.position.character >= candidate.pathRange.start.character
        && params.position.character <= candidate.pathRange.end.character,
      );
      if (include) {
        const start = include.pathRange.start.character;
        const end = include.pathRange.end.character;
        const resolved = await resolveInclude(
          include.path,
          params.textDocument.uri,
          workspace.includeCtx,
        );
        if (!resolved) return null;
        if (resolved.caseInsensitive) {
          connection.console.warn(
            `[UnityShaderNav] case-insensitive include match: "${include.path}" -> ${resolved.absolutePath}`,
          );
        }
        trace('include', {
          path: include.path,
          resolvedUri: pathToFileURL(resolved.absolutePath).href,
        });
        const targetUri = pathToFileURL(resolved.absolutePath).href;
        const targetRange = {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        };
        return [{
          targetUri,
          targetRange,
          targetSelectionRange: targetRange,
          originSelectionRange: {
            start: { line: params.position.line, character: start },
            end: { line: params.position.line, character: end },
          },
        }];
      }

      let idx = workspace.store.get(params.textDocument.uri);
      if (!idx && typeof workspace.reindex === 'function') {
        await workspace.reindex(doc.uri, fullText);
        idx = workspace.store.get(params.textDocument.uri);
      }
      if (!idx) {
        trace('index.missing', { uri: params.textDocument.uri });
        return null;
      }
      trace('index.loaded', {
        symbols: idx.symbols.length,
        references: idx.references.length,
      });

      // Forward direction (issue 20): cursor on a ShaderLab property name →
      // resolve the HLSL/CG declaration(s) of the same identifier. Runs BEFORE
      // `isGenericDefinitionContext` because the gate currently rejects every
      // non-HLSL cursor inside a `.shader` file. `idx.properties` is populated
      // at index time (Task 3) — no rescan here.
      const propertyHit = propertyAt(idx, params.position);
      if (propertyHit) {
        trace('property.hit', { name: propertyHit.name });
        const propertyVisibleUriKeys = await collectVisibleUriKeys(
          workspace.store,
          workspace.includeCtx,
          params.textDocument.uri,
        );
        // Filter to `variable` / `cbuffer` kinds only. Properties are uniform-
        // style data; the matching HLSL sibling is either a plain global
        // (`float _BumpScale;`), a cbuffer member, or a macro-synthesized
        // global. The macro matcher emits `symbolKind: 'variable'` for the
        // `TEXTURE2D($name)` family per `macros/matcher.ts:7` and
        // `macros/builtin.ts:10`, so they pass this filter. Functions, struct
        // members, parameters, locals, and macro-name symbols are dropped —
        // a `void _Foo()` next to a property `_Foo` is a name collision, not
        // a bridge target.
        const propertySymbols = resolveDefinitionSymbols(
          idx,
          propertyHit.name,
          params.position,
          workspace.global,
          { visibleUriKeys: propertyVisibleUriKeys, trace },
        ).filter((symbol) => symbol.kind === 'variable' || symbol.kind === 'cbuffer');
        if (propertySymbols.length === 0) {
          trace('property.forward', { links: 0 });
          return null;
        }
        trace('property.forward', { links: propertySymbols.length });
        return propertySymbols.map((symbol) => ({
          targetUri: symbol.location.uri,
          targetRange: symbol.location.range,
          targetSelectionRange: symbol.location.range,
          originSelectionRange: propertyHit.nameRange,
        }));
      }

      if (!isGenericDefinitionContext(fullText, params.position, doc.languageId, params.textDocument.uri)) {
        trace('context.rejected', {});
        return null;
      }

      const visibleUriKeys = await collectVisibleUriKeys(
        workspace.store,
        workspace.includeCtx,
        params.textDocument.uri,
      );
      const resolutionOptions = { visibleUriKeys, trace };
      trace('visibility', { visibleUriCount: visibleUriKeys.size });

      const memberAccess = memberAccessAt(fullText, params.position);
      trace('memberAccess', {
        member: memberAccess?.member.text,
        receiver: memberAccess?.receiver?.text,
      });
      if (memberAccess?.receiver) {
        const links = resolveMember(
          idx,
          workspace.global,
          memberAccess.receiver.text,
          memberAccess.member.text,
          params.position,
          resolutionOptions,
        );
        if (links.length > 0) {
          trace('member.result', { links: links.length });
          return links.map((link) => ({
            targetUri: link.targetUri,
            targetRange: link.targetRange,
            targetSelectionRange: link.targetSelectionRange,
            originSelectionRange: memberAccess.member.range,
          }));
        }
        trace('member.result', { links: 0 });
      }

      const word = wordAt(fullText, params.position);
      if (!word) {
        trace('word.missing', {});
        return null;
      }
      trace('word', {
        text: word.text,
        range: word.range,
      });

      const links = resolveDefinition(
        idx,
        word.text,
        params.position,
        workspace.global,
        resolutionOptions,
      );

      // Reverse direction (issue 20): an HLSL identifier may also match a
      // property name in any indexed `.shader`. Visibility is intentionally
      // bypassed (design decision 3) — every workspace shader whose Properties
      // block declares the same name surfaces as a candidate.
      const propertyCandidates = findPropertyCandidatesForName(word.text, workspace.store);
      const propertyLinks: LocationLink[] = propertyCandidates.map((cand) => ({
        targetUri: cand.uri,
        targetRange: cand.entry.declarationRange,
        targetSelectionRange: cand.entry.nameRange,
        originSelectionRange: word.range,
      }));

      if (links.length === 0 && propertyLinks.length === 0) {
        trace('definition.result', { links: 0 });
        return null;
      }
      trace('definition.result', {
        links: links.length + propertyLinks.length,
        hlsl: links.length,
        properties: propertyLinks.length,
      });

      const hlslLinks: LocationLink[] = links.map((link) => ({
        targetUri: link.targetUri,
        targetRange: link.targetRange,
        targetSelectionRange: link.targetSelectionRange,
        originSelectionRange: word.range,
      }));
      return [...hlslLinks, ...propertyLinks];
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
