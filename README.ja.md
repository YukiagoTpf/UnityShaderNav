# UnityShaderNav

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

UnityShaderNav は、Unity Shader プロジェクト向けの Visual Studio Code 拡張機能です。ShaderLab のラッパー構造、HLSL/CG include ファイル、Unity Packages、宣言マクロ、そして URP/HDRP プロジェクトでよく発生する同名シンボルや複数候補のナビゲーションを扱います。

この拡張機能は、高速なコードナビゲーションに重点を置いています。

- 関数、ローカル変数、引数、struct、struct メンバー、マクロ、`#include` パス、shader エントリポイントへの Go to Definition。
- インデックス済みのユーザーファイル内での Find References。必要に応じて package 内の参照も含められます。
- Unity Editor Adapter を介した File モード Shader Graph Custom Function
  ノードと HLSL のナビゲーション。F12 は精度サフィックス付き宣言を開き、
  Find References は graph ノードへ戻り、Problems は include の欠落、
  無効なサフィックス、port/signature の不一致を報告します。
- Adapter を介して ShaderLab Property の参照を現在の C# ソース呼び出しへ接続し、
  定数 `Shader.PropertyToID` フローと型付き `Material` /
  `MaterialPropertyBlock` Set/Get accessor を扱います。証明済みの型不一致は
  Problems に表示し、名前のみ／動的な証拠は不確実として明示します。既存の C#
  拡張機能と競合する language provider は登録しません。
- ShaderLab の `Shader`、`Fallback`、Pass `Name`、`UsePass` に対するプロジェクト横断の Definition、References、Hover、Completion、Workspace Symbols、および保守的な Rename。`UsePass` の Pass 部分は Unity の大文字の正規形に従います。
- 宣言が一意な HLSL/CG シンボルと、同じ `.shader` ファイル内の ShaderLab Property contract を対象とする保守的な Workspace Rename。オーバーロード、プリプロセッサ、Package など安全性を証明できない場合は変更を拒否します。
- Shader/HLSL、証明済み C#、シリアライズ済み Material の変更をグループ化する、
  明示的な安全な cross-asset Shader Property Rename プレビュー。リビジョン競合、
  動的証拠、読み取り専用 asset は Apply を禁止し、キャンセルや失敗時には準備済み
  Adapter 変更とソース編集をまとめてロールバックします。
- 解決できない vertex、fragment、geometry、hull、domain、surface、compute kernel エントリポイントを VS Code Problems に表示し、ライブドキュメントとプロジェクトインデックスに追従して更新します。
- SRP Batcher の material contract を保守的に検査し、`UnityPerMaterial` にないスカラー/ベクター Property、互換性のない型、確定可能な Pass 間 layout 差異を報告します。Quick Fix は安全な挿入先が一意の場合だけ提供します。
- インデックス済みシェーダーシンボル（関数、struct、メンバー、変数、引数、マクロ）の宣言サマリーに加え、一部の ShaderLab 用語、Property 構文、セマンティクス、SRP helper に公開ソース付き Quick Documentation を表示します。Unity プロジェクトでは `ProjectSettings/ProjectVersion.txt` から導出した表示専用の `UNITY_VERSION` 値も表示し、プロジェクトおよび Package の実際の宣言はこれらのバージョン対応フォールバックより優先されます。
- インデックス済み HLSL/CG コードの保守的な補完とシグネチャヘルプ、および厳選された Unity/HLSL/ShaderLab 組み込み語彙。
- 正しいコンテキストだけに表示される完全な Surface／vertex-fragment Shader、一般的な Material Property、Pass/program 構造、Blend state snippets、正規化された Color 既定リテラルの編集、および安全な ShaderLab インデント整形。
- ShaderLab ラッパー、Properties、Tags、render states、プリプロセッサ行、
  HLSL シンボル向けの Document Symbols とセマンティックカラーリング。
- インデックス済みのシェーダー関数、struct、struct メンバー、cbuffer、マクロ、
  グローバル変数を対象とした Workspace シンボル検索 (Ctrl+T / Cmd+T)。
  package 内のシンボルは既定では除外され、`findReferences.includePackages`
  設定に従います。
- 非アクティブおよび variant 依存の `#if`/`#ifdef` プリプロセッサ分岐を保守的に
  ディム表示します（表示のみで、ナビゲーションには影響しません）。
- オプションのバリアントコンテキストピッカー（ステータスバー + QuickPick）により、
  `multi_compile` / `shader_feature` の曖昧さを解消できます。アクティブな分岐は明るく
  表示され、非アクティブな分岐はディムされ、コンテキストにより対象が一意になる場合は
  F12 がアクティブなバリアントに直接ジャンプします。ユーザーが明示的に有効化する機能で、
  既定の動作は変わりません。
- ローカルと CI で同じように実行できる repository-owned Shader Variant budget
  コマンド。Shader、Pass、stage、platform ごとの declared/kept 上限を安定した
  human-readable／JSON レポートで検証し、必須 build evidence がない場合は
  `unverified` として失敗します。
- 必須 platform profile、compiler warning baseline、SRP Batcher Property、
  Variant budget を一つの repository Shader compile contract で検証し、CI で
  pass／failed／unverified を区別します。
- `Packages/packages-lock.json` による Unity Package の解決。
- `Library/UnityShaderNavCache/` 配下へのプロジェクトローカルなインデックスキャッシュ。

## ステータス

このプロジェクトは public preview 段階です。最新版は
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Yukiago.unity-shader-nav)
からインストールできます。ビルドとリリースノートは
[GitHub Releases](https://github.com/YukiagoTpf/UnityShaderNav/releases)、現在の作業は
[GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues) で確認できます。

## 対応ファイル

UnityShaderNav は次のファイルで有効になります。

- `.shader`
- `.hlsl`
- `.cginc`
- `.hlslinc`
- `.compute`
- `.shadergraph`（File モード Custom Function のナビゲーションには互換性の
  ある Unity Editor Adapter が必要です）

単独の HLSL ファイルでは同一ファイル内のナビゲーションが使えます。完全なクロスファイルナビゲーションには、`Assets/` と `ProjectSettings/` を含む Unity project root が必要です。

## インストール

### 方法 1: Visual Studio Marketplace からインストールする

1. Visual Studio Marketplace の [UnityShaderNav](https://marketplace.visualstudio.com/items?itemName=Yukiago.unity-shader-nav) を開きます。
2. **Install** を選択し、VS Code でインストールを完了します。

### 方法 2: Releases から VSIX をダウンロードする

1. [latest release](https://github.com/YukiagoTpf/UnityShaderNav/releases/latest) を開きます。
2. release assets から `unity-shader-nav-*.vsix` をダウンロードします。
3. VS Code で Extensions ビューを開きます。
4. `...` -> `Install from VSIX...` を選びます。
5. ダウンロードした VSIX ファイルを選択します。

インストール後、Unity プロジェクトを開き、`.shader`、`.hlsl`、`.cginc`、
`.hlslinc`、`.compute`、または `.shadergraph` ファイルを開いてください。

### 方法 3: ソースからビルドする

拡張機能を開発する場合や、ローカルで VSIX をパッケージする場合はこちらを使います。

必要なもの:

- VS Code 1.85 以降
- Node.js 18 以降
- npm

```powershell
npm ci
npm run build
```

ソースから拡張機能を実行する手順:

1. VS Code でリポジトリのルートを開きます。
2. ターミナルで `npm run watch` を実行し、`[watch-runtime] build ok` が表示されるまで待ちます。
3. F5 を押し、拡張機能の起動構成を選択します。
4. Extension Development Host で Unity プロジェクトを開きます。
5. `.shader`、`.hlsl`、`.cginc`、`.hlslinc`、`.compute`、または
   `.shadergraph` ファイルを開きます。
6. ソースを編集したら、次の `[watch-runtime] build ok` を待ってから Extension Development Host のウィンドウを再読み込みします。

ローカルで VSIX をパッケージする場合:

```powershell
npm run package:vsix
```

## 設定

主な設定:

```jsonc
{
  "unityShaderNav.projectRoot": "",
  "unityShaderNav.includeDirectories": [],
  "unityShaderNav.excludePatterns": ["**/Library/**", "**/Temp/**", "**/Logs/**"],
  "unityShaderNav.declarationMacros": [],
  "unityShaderNav.findReferences.includePackages": false
}
```

詳しい説明と例は [Configuration](docs/configuration.md) を参照してください。

## ドキュメント

- [User Guide](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Development Guide](docs/development.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Technical Spec](docs/technical-spec.md)
- [Shader Variant Budgets](docs/shader-budgets.md)
- [Shader Compile Contract](docs/shader-compile-contract.md)
- [Architecture Decision Records](docs/adr/)

## 既知の制限

- 既定ではプリプロセッサ条件を評価しません。複数の有効な定義がある場合は、VS Code の Peek Definition に複数候補として返します。オプションのバリアントコンテキストピッカーは、ディム表示とナビゲーションのために宣言済みの `multi_compile` / `shader_feature` キーワードを解決できますが、これはユーザー駆動のものであり、コンパイラー精度のバリアント解決を構成するものではありません。
- マクロ本体は展開しません。組み込みおよびユーザー設定の declaration patterns により、一般的な Unity マクロ宣言を扱います。
- Surface Shader の暗黙パラメータや Shader Graph 生成コードは、特別な
  ソースとしてインデックスしません。File モード Custom Function の
  ナビゲーションは、対応バージョンについて Unity Editor Adapter が提供する
  論理的な事実だけを使用します。Adapter または capability が利用できない場合、
  `.shadergraph` のシリアライズ形式を推測せず、中立のままです。
- 組み込み補完とシグネチャヘルプは厳選された非網羅的な語彙です。プロジェクトシンボルと組み込み名が衝突する場合は、プロジェクトシンボルを優先します。
- Quick Documentation も非網羅的です。Package 固有のフォールバックは、互換バージョンで include から可視な Unity built-in または既定 registry Package にだけ適用されます。Unity 向け文書は現在 Editor 2022.3 で検証済みで、それ以外または不明な Editor バージョンでも検証範囲の注記付きで表示されます。scoped registry、fork、ローカル由来、非互換の Package 情報は、実際のインデックス済み宣言がない限り中立のままです。
- Color presentation は HDR、Vector、式、範囲外の成分を扱いません。整形は ShaderLab の行頭インデントだけを変更し、埋め込み program/include block 全体のバイトを保持します。構造が不正な場合は拒否し、HLSL 整形は対象外です。
- Chain lookup は、複数行 receiver、マクロ展開 receiver、分岐依存の型、overload-specific return type inference などに対して保守的に動作します。
- SRP Batcher 検査は明示的な SRP 根拠を必要とし、`Color`、`Vector`、`Float`、`Range`、従来の float-backed `Int`、`Integer` Property のみを対象にします。texture resource、条件付きまたはマクロ生成の cbuffer layout、曖昧な複数 block の編集は自動修正しません。SubShader ごとの pipeline 所有権を証明できるまでは、複数 SubShader のファイルを診断しません。

## コントリビュート

bug report、最小再現、小さな PR を歓迎します。まず [CONTRIBUTING.md](CONTRIBUTING.md) を読み、現在の [issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues) を確認してください。

## ライセンス

UnityShaderNav は [MIT License](LICENSE) のもとで公開されています。
