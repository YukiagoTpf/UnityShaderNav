import type {
  InactiveRegionsParams,
  InactiveRegionsResult,
  Range,
} from '@unity-shader-nav/shared';

const SUPPORTED_LANGUAGES = new Set(['shaderlab', 'hlsl']);
const DEBOUNCE_MS = 300;

export interface InactiveRegionDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
}

export interface InactiveRegionDecoration {
  dispose(): void;
}

interface InactiveRegionDecorations<Decoration extends InactiveRegionDecoration> {
  readonly inactive: Decoration;
  readonly variant: Decoration;
}

export interface InactiveRegionControllerHost<
  Editor,
  RenderedRange,
  Timer,
  Decoration extends InactiveRegionDecoration = InactiveRegionDecoration,
> {
  describe(editor: Editor): InactiveRegionDocument;
  visibleEditors(): readonly Editor[];
  isEnabled(document: InactiveRegionDocument): boolean;
  opacity(document: InactiveRegionDocument): number;
  createDecorations(opacity: number): InactiveRegionDecorations<Decoration>;
  setDecorations(
    editor: Editor,
    decoration: Decoration,
    ranges: readonly RenderedRange[],
  ): void;
  toRange(range: Range): RenderedRange;
  request(params: InactiveRegionsParams): Promise<InactiveRegionsResult | null>;
  schedule(callback: () => void, delayMs: number): Timer;
  cancel(timer: Timer): void;
  reportError(error: unknown): void;
}

interface RequestToken {
  readonly version: number;
}

interface TimerToken<Timer> {
  readonly handle: Timer;
  readonly identity: object;
}

interface DocumentState<Timer, Decoration extends InactiveRegionDecoration> {
  document: InactiveRegionDocument;
  readonly opacity: number;
  decorations?: InactiveRegionDecorations<Decoration>;
  request?: RequestToken;
  timer?: TimerToken<Timer>;
}

export class InactiveRegionController<
  Editor,
  RenderedRange,
  Timer,
  Decoration extends InactiveRegionDecoration = InactiveRegionDecoration,
> {
  private readonly states = new Map<string, DocumentState<Timer, Decoration>>();
  private visible = new Map<Editor, InactiveRegionDocument>();

  constructor(
    private readonly host: InactiveRegionControllerHost<
      Editor,
      RenderedRange,
      Timer,
      Decoration
    >,
  ) {}

  visibleEditorsChanged(editors: readonly Editor[]): void {
    const nextVisible = new Map<Editor, InactiveRegionDocument>();
    const refreshed = new Set<string>();
    for (const editor of editors) {
      const document = this.host.describe(editor);
      nextVisible.set(editor, { ...document });
      const previous = this.visible.get(editor);
      if (
        previous?.uri === document.uri
        && previous.languageId === document.languageId
        && previous.version === document.version
      ) continue;
      if (refreshed.has(document.uri)) continue;
      refreshed.add(document.uri);
      this.refresh(editor);
    }
    this.visible = nextVisible;
  }

  refresh(editor: Editor | undefined): void {
    if (editor === undefined) return;
    const document = this.host.describe(editor);
    if (!SUPPORTED_LANGUAGES.has(document.languageId) || !this.host.isEnabled(document)) {
      this.release(document.uri);
      return;
    }

    const state = this.stateFor(document);
    this.cancelTimer(state);
    const decorations = state.decorations
      ?? (state.decorations = this.host.createDecorations(state.opacity));
    const request: RequestToken = { version: document.version };
    state.request = request;
    const params: InactiveRegionsParams = {
      textDocument: { uri: document.uri, version: document.version },
    };

    void this.host.request(params).then(
      (result) => this.accept(document.uri, request, decorations, result),
      (error) => {
        const current = this.states.get(document.uri);
        if (current?.request !== request) return;
        current.request = undefined;
        this.host.reportError(error);
      },
    );
  }

  documentChanged(document: InactiveRegionDocument): void {
    if (!SUPPORTED_LANGUAGES.has(document.languageId) || !this.host.isEnabled(document)) {
      this.release(document.uri);
      return;
    }

    const state = this.stateFor(document);
    this.cancelTimer(state);
    state.request = undefined;
    const identity = {};
    const handle = this.host.schedule(() => {
      const current = this.states.get(document.uri);
      if (current?.timer?.identity !== identity) return;
      current.timer = undefined;
      const editor = this.host.visibleEditors().find(
        (candidate) => this.host.describe(candidate).uri === document.uri,
      );
      if (editor !== undefined) this.refresh(editor);
    }, DEBOUNCE_MS);
    state.timer = { handle, identity };
  }

  documentClosed(uri: string): void {
    this.release(uri);
    for (const [editor, document] of this.visible) {
      if (document.uri === uri) this.visible.delete(editor);
    }
  }

  configurationChanged(): void {
    for (const [uri, state] of this.states) {
      if (
        !SUPPORTED_LANGUAGES.has(state.document.languageId)
        || !this.host.isEnabled(state.document)
        || this.host.opacity(state.document) !== state.opacity
      ) {
        this.release(uri);
      }
    }

    const refreshed = new Set<string>();
    for (const editor of this.host.visibleEditors()) {
      const document = this.host.describe(editor);
      if (refreshed.has(document.uri) || this.states.has(document.uri)) continue;
      if (!SUPPORTED_LANGUAGES.has(document.languageId) || !this.host.isEnabled(document)) continue;
      refreshed.add(document.uri);
      this.refresh(editor);
    }
  }

  dispose(): void {
    for (const uri of [...this.states.keys()]) this.release(uri);
    this.visible.clear();
  }

  private stateFor(document: InactiveRegionDocument): DocumentState<Timer, Decoration> {
    const existing = this.states.get(document.uri);
    const opacity = this.host.opacity(document);
    if (existing && existing.opacity === opacity) {
      existing.document = document;
      return existing;
    }
    if (existing) this.release(document.uri);
    const created: DocumentState<Timer, Decoration> = {
      document,
      opacity,
    };
    this.states.set(document.uri, created);
    return created;
  }

  private accept(
    uri: string,
    request: RequestToken,
    decorations: InactiveRegionDecorations<Decoration>,
    result: InactiveRegionsResult | null,
  ): void {
    const state = this.states.get(uri);
    if (!state || state.request !== request) return;
    state.request = undefined;
    if (!result || result.version !== request.version) return;

    const inactive: RenderedRange[] = [];
    const variant: RenderedRange[] = [];
    for (const region of result.regions) {
      (region.reason === 'inactive' ? inactive : variant).push(this.host.toRange(region.range));
    }

    for (const editor of this.host.visibleEditors()) {
      const document = this.host.describe(editor);
      if (document.uri !== uri || document.version !== request.version) continue;
      this.host.setDecorations(editor, decorations.inactive, inactive);
      this.host.setDecorations(editor, decorations.variant, variant);
    }
  }

  private cancelTimer(state: DocumentState<Timer, Decoration>): void {
    if (!state.timer) return;
    this.host.cancel(state.timer.handle);
    state.timer = undefined;
  }

  private release(uri: string): void {
    const state = this.states.get(uri);
    if (!state) return;
    this.cancelTimer(state);
    state.decorations?.inactive.dispose();
    state.decorations?.variant.dispose();
    this.states.delete(uri);
  }
}
