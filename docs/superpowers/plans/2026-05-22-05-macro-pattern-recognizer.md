# Plan 05: Macro Pattern Recognizer 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ADR-0003 的 declaration / reference macro 白名单系统。让 `TEXTURE2D(_MainTex)` / `SAMPLER(sampler_MainTex)` / `CBUFFER_START(name)` 等"通过宏声明"的符号进入索引（作为 `variable` / `cbuffer`），让 `#pragma vertex vert` / `#pragma fragment frag` / `#pragma kernel CSMain` 等指令把目标函数名记为 `'pragma'` 引用。覆盖 Spec §10 Case 5、6、7。

**Architecture:**
- `MacroPatternTable`：静态内置一组 Unity 官方稳定模式（来自 URP/HDRP/Core RP）+ 用户配置 (`unityShaderNav.declarationMacros`) 合并；模式语法用 `$name` / `$func` / `_`（占位、忽略）。
- `MacroPatternMatcher`：把模式编译成"宏名 + 参数位置选择器"，对每个 call_expression / pragma 行做 O(1) lookup。
- 在 `collector.ts` 中加两个新分支：识别到 call_expression 时查 declaration 表；扫文本行级 `#pragma` 时查 reference 表。
- 用户配置合并发生在 server 启动后从 client 拉 `workspace/configuration`；本计划顺带搭起 settings pipeline。

**Tech Stack:** 同前。

**Dependencies:** Plan 01-04。

---

## File Structure

新建：
```
server/src/macros/
├── patterns.ts            # 模式语法定义、解析
├── builtin.ts             # 内置 Unity 白名单常量
├── table.ts               # MacroPatternTable（合并 builtin + user）
├── matcher.ts             # 在 collector 中调用的匹配器
└── index.ts

server/src/config/
├── settings.ts            # ExtensionSettings 类型 + 从 connection 拉取
└── index.ts

shared/src/settings.ts     # ExtensionSettings 接口（与 spec §9 对齐）

server/tests/macros/
├── patterns.test.ts
├── matcher.test.ts
└── fixtures/
    ├── textures.hlsl              # TEXTURE2D + SAMPLER + UNITY_DECLARE_TEX2D
    ├── cbuffer-macro.hlsl         # CBUFFER_START / CBUFFER_END
    ├── instanced-prop.hlsl        # UNITY_DEFINE_INSTANCED_PROP
    ├── cg-legacy.hlsl             # sampler2D / fixed4 旧式声明（CG 兼容）
    └── pragmas.shader             # #pragma vertex / fragment / kernel
```

修改：
- `server/src/parser/hlsl/collector.ts` — call_expression 分支注入 macro pattern lookup
- `server/src/parser/hlsl/fileIndexer.ts` — 在每个块的原始文本上做 pragma 行扫描
- `server/src/server.ts` — 拉取 settings，构造 `MacroPatternTable` 并传入
- `client/package.json` — 加 `contributes.configuration` 描述 `unityShaderNav.declarationMacros`

---

## Task 1: shared settings 类型

**Files:**
- Create: `shared/src/settings.ts`
- Modify: `shared/src/protocol.ts`

- [ ] **Step 1: 类型**

```typescript
export type DeclarationMacroKind = 'variable' | 'cbuffer';

export interface UserDeclarationMacro {
  /** Pattern source, e.g. "MY_TEX2D($name)" or "MY_CBUFFER($name)". */
  pattern: string;
  /** Symbol kind to register the captured $name as. */
  kind: DeclarationMacroKind;
}

export interface ExtensionSettings {
  projectRoot: string;
  includeDirectories: string[];
  excludePatterns: string[];
  declarationMacros: UserDeclarationMacro[];
  findReferences: { includePackages: boolean };
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  projectRoot: '',
  includeDirectories: [],
  excludePatterns: ['**/Library/**', '**/Temp/**', '**/Logs/**'],
  declarationMacros: [],
  findReferences: { includePackages: false },
};
```

- [ ] **Step 2: 在 `protocol.ts` re-export**

```typescript
export * from './settings';
```

- [ ] **Step 3: build + Commit**

```bash
npm run build -w @unity-shader-nav/shared
git add shared/src/{settings.ts,protocol.ts}
git commit -m "feat(plan-05): ExtensionSettings type with macros & references config"
```

---

## Task 2: 模式语法 & 解析器

**Files:**
- Create: `server/src/macros/patterns.ts`
- Create: `server/tests/macros/patterns.test.ts`

模式规则：
- `IDENTIFIER` — 字面宏名（如 `TEXTURE2D`）
- `$name` — 命名捕获组（参数位置上的 identifier）
- `$func` — 同义于 `$name`，语义上是函数名
- `_` — 占位，匹配任意参数但不捕获
- `,` `(` `)` — 字面分隔

例如：`TEXTURE2D($name)`、`UNITY_DEFINE_INSTANCED_PROP(_, $name)`、`#pragma vertex $func`。

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../src/macros/patterns';

describe('parsePattern', () => {
  it('parses a single-capture macro', () => {
    const p = parsePattern('TEXTURE2D($name)');
    expect(p.head).toBe('TEXTURE2D');
    expect(p.params.map((x) => x.kind)).toEqual(['capture']);
    expect(p.params[0].name).toBe('name');
  });

  it('parses a macro with placeholder + capture', () => {
    const p = parsePattern('UNITY_DEFINE_INSTANCED_PROP(_, $name)');
    expect(p.head).toBe('UNITY_DEFINE_INSTANCED_PROP');
    expect(p.params.map((x) => x.kind)).toEqual(['placeholder', 'capture']);
  });

  it('parses a #pragma reference pattern', () => {
    const p = parsePattern('#pragma vertex $func');
    expect(p.head).toBe('#pragma vertex');
    expect(p.params).toHaveLength(1);
    expect(p.params[0].kind).toBe('capture');
  });

  it('throws on malformed input', () => {
    expect(() => parsePattern('TEXTURE2D')).toThrow();
  });
});
```

- [ ] **Step 2: 实现**

```typescript
export type ParamKind = 'capture' | 'placeholder';

export interface ParamSlot {
  kind: ParamKind;
  /** When kind === 'capture', the variable name (e.g. "name" / "func"). */
  name?: string;
}

export interface CompiledPattern {
  /** For call macros: the macro name. For pragma references: "#pragma vertex" (head string). */
  head: string;
  params: ParamSlot[];
  isPragma: boolean;
}

const PARAM_RE = /^\s*(?:\$(\w+)|_|)\s*$/;

export function parsePattern(src: string): CompiledPattern {
  const isPragma = src.startsWith('#pragma');
  if (isPragma) {
    // syntax: "#pragma <directive> $func"
    const m = /^#pragma\s+(\S+)\s+\$(\w+)\s*$/.exec(src);
    if (!m) throw new Error(`malformed pragma pattern: ${src}`);
    return {
      head: `#pragma ${m[1]}`,
      params: [{ kind: 'capture', name: m[2] }],
      isPragma: true,
    };
  }

  const m = /^([A-Z_][A-Z0-9_]*)\s*\((.*)\)\s*$/.exec(src);
  if (!m) throw new Error(`malformed macro pattern: ${src}`);
  const head = m[1];
  const inside = m[2].trim();
  const params: ParamSlot[] = inside.length === 0
    ? []
    : inside.split(',').map((raw) => {
      const pm = PARAM_RE.exec(raw);
      if (!pm) throw new Error(`bad param ${raw} in ${src}`);
      if (pm[1]) return { kind: 'capture' as const, name: pm[1] };
      return { kind: 'placeholder' as const };
    });

  return { head, params, isPragma: false };
}
```

- [ ] **Step 3: 跑测试 + Commit**

```bash
npx vitest run server/tests/macros/patterns.test.ts
git add server/src/macros/patterns.ts server/tests/macros/patterns.test.ts
git commit -m "feat(plan-05): macro pattern grammar parser"
```

---

## Task 3: 内置模式表

**Files:**
- Create: `server/src/macros/builtin.ts`

- [ ] **Step 1: 写表（参考 URP / HDRP / Core RP）**

```typescript
import type { DeclarationMacroKind } from '@unity-shader-nav/shared';

export interface BuiltinMacroPattern {
  pattern: string;
  kind: DeclarationMacroKind | 'function-reference';
}

export const BUILTIN_DECLARATION_MACROS: BuiltinMacroPattern[] = [
  // Textures
  { pattern: 'TEXTURE2D($name)',                kind: 'variable' },
  { pattern: 'TEXTURE2D_X($name)',              kind: 'variable' },
  { pattern: 'TEXTURE2D_ARRAY($name)',          kind: 'variable' },
  { pattern: 'TEXTURE3D($name)',                kind: 'variable' },
  { pattern: 'TEXTURECUBE($name)',              kind: 'variable' },
  { pattern: 'TEXTURECUBE_ARRAY($name)',        kind: 'variable' },
  // Samplers
  { pattern: 'SAMPLER($name)',                  kind: 'variable' },
  { pattern: 'SAMPLER_CMP($name)',              kind: 'variable' },
  // Legacy Unity declarations
  { pattern: 'UNITY_DECLARE_TEX2D($name)',      kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEX2D_NOSAMPLER($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEX2DARRAY($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEXCUBE($name)',    kind: 'variable' },
  // Instancing
  { pattern: 'UNITY_DEFINE_INSTANCED_PROP(_, $name)', kind: 'variable' },
  // cbuffer
  { pattern: 'CBUFFER_START($name)',            kind: 'cbuffer'  },
];

export const BUILTIN_REFERENCE_MACROS: BuiltinMacroPattern[] = [
  { pattern: '#pragma vertex $func',   kind: 'function-reference' },
  { pattern: '#pragma fragment $func', kind: 'function-reference' },
  { pattern: '#pragma geometry $func', kind: 'function-reference' },
  { pattern: '#pragma hull $func',     kind: 'function-reference' },
  { pattern: '#pragma domain $func',   kind: 'function-reference' },
  { pattern: '#pragma kernel $func',   kind: 'function-reference' },
];
```

- [ ] **Step 2: Commit**

```bash
git add server/src/macros/builtin.ts
git commit -m "feat(plan-05): builtin Unity macro whitelist"
```

---

## Task 4: MacroPatternTable

**Files:**
- Create: `server/src/macros/table.ts`
- Create: `server/src/macros/index.ts`

- [ ] **Step 1: 实现**

```typescript
import type { UserDeclarationMacro } from '@unity-shader-nav/shared';
import { BUILTIN_DECLARATION_MACROS, BUILTIN_REFERENCE_MACROS } from './builtin';
import { parsePattern, type CompiledPattern } from './patterns';

export interface CompiledDeclaration {
  pattern: CompiledPattern;
  symbolKind: 'variable' | 'cbuffer';
}

export interface CompiledReference {
  pattern: CompiledPattern;
}

export class MacroPatternTable {
  private readonly declByHead = new Map<string, CompiledDeclaration[]>();
  private readonly refByHead  = new Map<string, CompiledReference[]>();

  constructor(userMacros: UserDeclarationMacro[] = []) {
    for (const m of BUILTIN_DECLARATION_MACROS) {
      if (m.kind === 'function-reference') continue;
      this.addDecl(m.pattern, m.kind);
    }
    for (const m of BUILTIN_REFERENCE_MACROS) {
      this.addRef(m.pattern);
    }
    for (const u of userMacros) {
      this.addDecl(u.pattern, u.kind);
    }
  }

  private addDecl(pattern: string, kind: 'variable' | 'cbuffer'): void {
    const compiled = parsePattern(pattern);
    const head = compiled.head;
    const arr = this.declByHead.get(head) ?? [];
    arr.push({ pattern: compiled, symbolKind: kind });
    this.declByHead.set(head, arr);
  }

  private addRef(pattern: string): void {
    const compiled = parsePattern(pattern);
    const head = compiled.head;
    const arr = this.refByHead.get(head) ?? [];
    arr.push({ pattern: compiled });
    this.refByHead.set(head, arr);
  }

  findDecl(head: string): CompiledDeclaration[] {
    return this.declByHead.get(head) ?? [];
  }

  findRef(head: string): CompiledReference[] {
    return this.refByHead.get(head) ?? [];
  }
}
```

- [ ] **Step 2: index**

```typescript
export { MacroPatternTable } from './table';
export type { CompiledDeclaration, CompiledReference } from './table';
export { parsePattern } from './patterns';
```

- [ ] **Step 3: Commit**

```bash
git add server/src/macros/{table.ts,index.ts}
git commit -m "feat(plan-05): MacroPatternTable merging builtin + user patterns"
```

---

## Task 5: matcher — call_expression → declaration

**Files:**
- Create: `server/src/macros/matcher.ts`
- Create: `server/tests/macros/matcher.test.ts`
- Create: `server/tests/macros/fixtures/textures.hlsl`
- Create: `server/tests/macros/fixtures/cbuffer-macro.hlsl`
- Create: `server/tests/macros/fixtures/instanced-prop.hlsl`

- [ ] **Step 1: fixtures**

`textures.hlsl`:
```hlsl
TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);
TEXTURE2D_ARRAY(_ShadowMaps);
```

`cbuffer-macro.hlsl`:
```hlsl
CBUFFER_START(UnityPerMaterial)
    float4 _Color;
CBUFFER_END
```

`instanced-prop.hlsl`:
```hlsl
UNITY_INSTANCING_BUFFER_START(Props)
    UNITY_DEFINE_INSTANCED_PROP(float4, _BaseColor)
UNITY_INSTANCING_BUFFER_END(Props)
```

- [ ] **Step 2: 测试 matcher**

```typescript
import { describe, it, expect } from 'vitest';
import type Parser from 'web-tree-sitter';
import { parseHlsl } from '../../src/parser/hlsl/parser';
import { MacroPatternTable } from '../../src/macros';
import { matchDeclarationCall } from '../../src/macros/matcher';

describe('matcher: TEXTURE2D / SAMPLER', () => {
  it('extracts _MainTex from TEXTURE2D call', async () => {
    const tree = await parseHlsl('TEXTURE2D(_MainTex);');
    const table = new MacroPatternTable();
    const calls: Parser.SyntaxNode[] = [];
    const walk = (n: Parser.SyntaxNode) => {
      if (n.type === 'call_expression') calls.push(n);
      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
    };
    walk(tree.rootNode);

    expect(calls).toHaveLength(1);
    const match = matchDeclarationCall(calls[0], table);
    expect(match?.symbolKind).toBe('variable');
    expect(match?.capturedName).toBe('_MainTex');
  });
});
```

- [ ] **Step 3: 实现**

```typescript
import type Parser from 'web-tree-sitter';
import type { MacroPatternTable, CompiledDeclaration } from './index';
import type { Range } from '@unity-shader-nav/shared';
import { rangeOf, textOf } from '../parser/hlsl/nodeHelpers';

export interface DeclarationMatch {
  symbolKind: 'variable' | 'cbuffer';
  capturedName: string;
  nameRange: Range;
}

export function matchDeclarationCall(
  callNode: Parser.SyntaxNode,
  table: MacroPatternTable,
): DeclarationMatch | null {
  const callee = callNode.childForFieldName('function') ?? callNode.namedChild(0);
  if (!callee || callee.type !== 'identifier') return null;
  const head = textOf(callee);

  const candidates = table.findDecl(head);
  if (candidates.length === 0) return null;

  const args = (
    callNode.childForFieldName('arguments')
      ?? callNode.descendantsOfType('argument_list')[0]
  )?.namedChildren ?? [];

  for (const cand of candidates) {
    if (cand.pattern.params.length !== args.length) continue;
    let capturedIndex = -1;
    for (let i = 0; i < cand.pattern.params.length; i++) {
      if (cand.pattern.params[i].kind === 'capture') {
        capturedIndex = i;
        break;
      }
    }
    if (capturedIndex < 0) continue;

    const arg = args[capturedIndex];
    const nameNode = arg.type === 'identifier' ? arg : arg.descendantsOfType('identifier')[0];
    if (!nameNode) continue;

    return {
      symbolKind: cand.symbolKind,
      capturedName: textOf(nameNode),
      nameRange: rangeOf(nameNode),
    };
  }

  return null;
}
```

- [ ] **Step 4: 跑测试，PASS。Commit**

```bash
git add server/src/macros/matcher.ts server/tests/macros/{fixtures,matcher.test.ts}
git commit -m "feat(plan-05): match call_expression against declaration patterns"
```

---

## Task 6: matcher — `#pragma` reference patterns

**Files:**
- Create: `server/tests/macros/fixtures/pragmas.shader`
- Modify: `server/src/macros/matcher.ts`
- Modify: `server/tests/macros/matcher.test.ts`

- [ ] **Step 1: fixture**

```hlsl
Shader "T/Pragma" {
  SubShader {
    Pass {
      HLSLPROGRAM
      #pragma vertex vert
      #pragma fragment frag
      void vert() {}
      float4 frag() : SV_Target { return 0; }
      ENDHLSL
    }
  }
}
```

- [ ] **Step 2: 测试**

```typescript
import { matchPragmaLine } from '../../src/macros/matcher';

describe('matcher: #pragma vertex', () => {
  it('returns target identifier and range', () => {
    const table = new MacroPatternTable();
    const line = '      #pragma vertex vert';
    const match = matchPragmaLine(line, 5, table);
    expect(match?.capturedName).toBe('vert');
    expect(match?.nameRange.start.line).toBe(5);
    expect(line.slice(match!.nameRange.start.character, match!.nameRange.end.character)).toBe('vert');
  });

  it('returns null for unrecognized pragma', () => {
    const table = new MacroPatternTable();
    expect(matchPragmaLine('#pragma multi_compile _ FOG', 0, table)).toBeNull();
  });
});
```

- [ ] **Step 3: 实现**

```typescript
export interface ReferenceMatch {
  capturedName: string;
  nameRange: Range;
}

export function matchPragmaLine(
  line: string,
  lineNumber: number,
  table: MacroPatternTable,
): ReferenceMatch | null {
  // strip comments
  const text = line.replace(/\/\/.*$/, '');
  const m = /^\s*(#pragma\s+\S+)\s+(\S+)/.exec(text);
  if (!m) return null;
  const head = m[1];

  const candidates = table.findRef(head);
  if (candidates.length === 0) return null;

  const captured = m[2];
  const startChar = text.indexOf(captured, m[0].length - captured.length);
  return {
    capturedName: captured,
    nameRange: {
      start: { line: lineNumber, character: startChar },
      end:   { line: lineNumber, character: startChar + captured.length },
    },
  };
}
```

- [ ] **Step 4: 跑测试 + Commit**

```bash
git add server/src/macros/matcher.ts server/tests/macros/{fixtures/pragmas.shader,matcher.test.ts}
git commit -m "feat(plan-05): match #pragma vertex/fragment/kernel references"
```

---

## Task 7: 接入 collector + fileIndexer

**Files:**
- Modify: `server/src/parser/hlsl/collector.ts`（注入 macro 检查；现有"call_expression" 分支增强）
- Modify: `server/src/parser/hlsl/fileIndexer.ts`（增加 pragma 行扫描）

- [ ] **Step 1: 在 collector 内 inject macro table**

签名修改：`collect(root, text, uri, lineOffset, table?: MacroPatternTable)`。当 `table` 存在且当前节点是 `call_expression`，调 `matchDeclarationCall`；命中则登记 symbol（kind 取 `match.symbolKind`，name range 在原文偏移）。

```typescript
// 在 walk 循环中：
if (node.type === 'call_expression') {
  if (table) {
    const m = matchDeclarationCall(node, table);
    if (m) {
      st.symbols.push({
        name: m.capturedName,
        kind: m.symbolKind === 'cbuffer' ? 'cbuffer' : 'variable',
        location: { uri: st.uri, range: offsetRange(m.nameRange, st.lineOffset) },
      });
      continue; // don't also record as a normal call reference
    }
  }
  // ... existing call reference logic
}
```

- [ ] **Step 2: fileIndexer 接收 table，pragma 扫描**

签名：`indexFile(uri, text, table?: MacroPatternTable)`。

```typescript
function scanPragmas(blockText: string, lineOffset: number, table: MacroPatternTable, uri: string): ReferenceEntry[] {
  const refs: ReferenceEntry[] = [];
  const lines = blockText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = matchPragmaLine(lines[i], i, table);
    if (!m) continue;
    refs.push({
      name: m.capturedName,
      context: 'pragma',
      location: {
        uri,
        range: {
          start: { line: m.nameRange.start.line + lineOffset, character: m.nameRange.start.character },
          end:   { line: m.nameRange.end.line   + lineOffset, character: m.nameRange.end.character   },
        },
      },
    });
  }
  return refs;
}
```

在 `indexFile` 中：每个 HLSL 块的内容做完 AST collect 后，再加上 `scanPragmas`。

- [ ] **Step 3: 更新 documents handler 传入 table**

```typescript
export function registerDocuments(connection, store, table: MacroPatternTable) { ... }
// reindex: await indexFile(doc.uri, doc.getText(), table);
```

- [ ] **Step 4: 更新单元测试**——给 `collector.test.ts` 和 `fileIndexer.test.ts` 加表参数；建一个新测试 `server/tests/macros/integration.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexFile } from '../../src/parser/hlsl';
import { MacroPatternTable } from '../../src/macros';

describe('integration: macros end-to-end', () => {
  it('TEXTURE2D(_MainTex) registers _MainTex as variable', async () => {
    const text = readFileSync(join(__dirname, 'fixtures/textures.hlsl'), 'utf8');
    const idx = await indexFile('file:///t/textures.hlsl', text, new MacroPatternTable());
    const main = idx.symbols.find((s) => s.name === '_MainTex');
    expect(main).toBeDefined();
    expect(main?.kind).toBe('variable');
  });

  it('#pragma vertex vert registers vert as pragma reference', async () => {
    const text = readFileSync(join(__dirname, 'fixtures/pragmas.shader'), 'utf8');
    const idx = await indexFile('file:///t/pragmas.shader', text, new MacroPatternTable());
    const vertRef = idx.references.find((r) => r.name === 'vert' && r.context === 'pragma');
    expect(vertRef).toBeDefined();
  });

  it('CBUFFER_START(UnityPerMaterial) registers UnityPerMaterial as cbuffer', async () => {
    const text = readFileSync(join(__dirname, 'fixtures/cbuffer-macro.hlsl'), 'utf8');
    const idx = await indexFile('file:///t/cb.hlsl', text, new MacroPatternTable());
    const cb = idx.symbols.find((s) => s.name === 'UnityPerMaterial');
    expect(cb?.kind).toBe('cbuffer');
  });
});
```

- [ ] **Step 5: 跑测试 + Commit**

```bash
npm run build -w @unity-shader-nav/server
npx vitest run
git add server/src server/tests/macros/integration.test.ts
git commit -m "feat(plan-05): wire macro recognition into collector + fileIndexer"
```

---

## Task 8: 用户配置 pipeline (`unityShaderNav.declarationMacros`)

**Files:**
- Create: `server/src/config/settings.ts`
- Create: `server/src/config/index.ts`
- Modify: `server/src/server.ts`
- Modify: `client/package.json`（声明配置 schema）

- [ ] **Step 1: 客户端 contributes.configuration**

修改 `client/package.json` `contributes`：

```json
"configuration": {
  "title": "UnityShaderNav",
  "properties": {
    "unityShaderNav.projectRoot": {
      "type": "string", "default": "",
      "description": "Path to Unity project root (containing Assets/ and ProjectSettings/). Empty = autodetect."
    },
    "unityShaderNav.includeDirectories": {
      "type": "array", "items": { "type": "string" }, "default": [],
      "description": "Extra include search paths."
    },
    "unityShaderNav.excludePatterns": {
      "type": "array", "items": { "type": "string" },
      "default": ["**/Library/**", "**/Temp/**", "**/Logs/**"]
    },
    "unityShaderNav.declarationMacros": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pattern": { "type": "string", "description": "e.g. MY_TEX2D($name)" },
          "kind":    { "type": "string", "enum": ["variable", "cbuffer"] }
        },
        "required": ["pattern", "kind"]
      },
      "default": []
    },
    "unityShaderNav.findReferences.includePackages": {
      "type": "boolean", "default": false
    }
  }
}
```

- [ ] **Step 2: 服务端 settings 拉取**

```typescript
// server/src/config/settings.ts
import type { Connection } from 'vscode-languageserver/node';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@unity-shader-nav/shared';

export async function loadSettings(connection: Connection): Promise<ExtensionSettings> {
  try {
    const got = await connection.workspace.getConfiguration({ section: 'unityShaderNav' });
    return { ...DEFAULT_SETTINGS, ...(got ?? {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function onSettingsChanged(
  connection: Connection,
  onChange: (s: ExtensionSettings) => void | Promise<void>,
): void {
  connection.onDidChangeConfiguration(async () => {
    const s = await loadSettings(connection);
    await onChange(s);
  });
}
```

- [ ] **Step 3: server.ts 接入**

```typescript
import { loadSettings, onSettingsChanged } from './config/settings';
import { MacroPatternTable } from './macros';

let table = new MacroPatternTable();
const store = new IndexStore();

connection.onInitialize(() => createInitializeResult());
connection.onInitialized(async () => {
  const settings = await loadSettings(connection);
  table = new MacroPatternTable(settings.declarationMacros);
  // re-index all open docs
  for (const doc of documents.all()) {
    store.set(doc.uri, await indexFile(doc.uri, doc.getText(), table));
  }
});

onSettingsChanged(connection, async (settings) => {
  table = new MacroPatternTable(settings.declarationMacros);
  for (const doc of documents.all()) {
    store.set(doc.uri, await indexFile(doc.uri, doc.getText(), table));
  }
});

const documents = registerDocuments(connection, store, () => table);
registerDefinitionHandler(connection, documents, store);
```

> 注意：把 `table` 设为 getter（闭包返回最新值），免得 documents handler 被绑死到第一份 table。

- [ ] **Step 4: build + Commit**

```bash
npm run build
git add server/src client/package.json
git commit -m "feat(plan-05): user-config pipeline for declarationMacros"
```

---

## Task 9: 端到端集成测（test-electron）

**Files:**
- Create: `tests/integration/client/fixtures/macros/main.hlsl`
- Create: `tests/integration/client/macros.test.ts`

- [ ] **Step 1: fixture**

```hlsl
TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);

float4 frag() : SV_Target {
    return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, float2(0, 0));
}
```

> 这里 F12 在 `_MainTex` 调用点上要跳到第 0 行的 `TEXTURE2D(_MainTex)` 处。

- [ ] **Step 2: 测试**

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';

suite('F12 on macro-declared variable', () => {
  test('jumps from _MainTex usage to TEXTURE2D declaration', async () => {
    const fp = path.resolve(__dirname, 'fixtures/macros/main.hlsl');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 800));

    // line 4 (0-based): "    return SAMPLE_TEXTURE2D(_MainTex, ..."
    // find _MainTex column
    const lineText = doc.lineAt(4).text;
    const col = lineText.indexOf('_MainTex');
    const pos = new vscode.Position(4, col + 3); // inside the word

    const links = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', uri, pos,
    );
    assert.ok(links && links.length >= 1);
    const target = links[0].targetRange ?? links[0].range;
    assert.strictEqual(target.start.line, 0);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/client/macros.test.ts tests/integration/client/fixtures/macros
git commit -m "test(plan-05): e2e F12 on macro-declared variable"
```

---

## Acceptance

1. ✅ 单元测试全过（patterns / matcher / integration）
2. ✅ 集成测试全过（test-electron 上 F12 在 `_MainTex` 跳到 `TEXTURE2D(_MainTex)`）
3. ✅ Spec §10 **Case 5**：F12 在 `TEXTURE2D(_MainTex)` 后某使用点 `_MainTex` 上 → 跳到声明处
4. ✅ Spec §10 **Case 6**：F12 在 `#pragma vertex vert` 的 `vert` 上 → 跳到 `vert` 函数定义
5. ✅ Spec §10 **Case 7**：F12 在 `.compute` 文件的 `#pragma kernel CSMain` 的 `CSMain` 上 → 跳到 CSMain 函数（需要一个 `.compute` 测试 fixture）
6. ✅ 用户在 settings 加 `MY_TEX2D($name)` → 重新索引后该宏声明可识别（手动验证）

## Manual Verification

1. F5 → Extension Development Host
2. 在工作区里写一个 `.hlsl`：
   ```hlsl
   TEXTURE2D(_MainTex);
   float4 frag() { return _MainTex.Sample(...); }
   ```
3. F12 on `_MainTex` → 跳到第 0 行 TEXTURE2D 声明位置
4. 写一个 `.compute`：
   ```hlsl
   #pragma kernel CSMain
   [numthreads(8,8,1)]
   void CSMain(uint3 id : SV_DispatchThreadID) {}
   ```
5. F12 on `CSMain`（在 `#pragma kernel` 行） → 跳到 `CSMain` 函数
6. settings.json 加：
   ```json
   "unityShaderNav.declarationMacros": [{ "pattern": "MY_TEX2D($name)", "kind": "variable" }]
   ```
7. 在 .hlsl 里 `MY_TEX2D(_Custom);` 然后 F12 on `_Custom` 使用点 → 跳转成功

完成后进入 Plan 06。
