# UnityShaderNav

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

UnityShaderNav は、Unity Shader プロジェクト向けの Visual Studio Code 拡張機能です。ShaderLab のラッパー構造、HLSL/CG include ファイル、Unity Packages、宣言マクロ、そして URP/HDRP プロジェクトでよく発生する同名シンボルや複数候補のナビゲーションを扱います。

この拡張機能は、高速なコードナビゲーションに重点を置いています。

- 関数、ローカル変数、引数、struct、struct メンバー、マクロ、`#include` パス、shader エントリポイントへの Go to Definition。
- インデックス済みのユーザーファイル内での Find References。必要に応じて package 内の参照も含められます。
- インデックス済み HLSL/CG コードの保守的な補完とシグネチャヘルプ、および厳選された Unity/HLSL/ShaderLab 組み込み語彙。
- ShaderLab と HLSL ファイル向けの Document Symbols とセマンティックカラーリング。
- `Packages/packages-lock.json` による Unity Package の解決。
- `Library/UnityShaderNavCache/` 配下へのプロジェクトローカルなインデックスキャッシュ。

## ステータス

このプロジェクトは現在、初期の public preview 段階です。コア language server は動作しており、ユニットテストと VS Code 統合テストでカバーされています。一方で、Marketplace への公開、release 自動化、CI キャッシュ調整、一部の Unity パスのエッジケースは、まだ [GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues) で追跡しています。

## 対応ファイル

UnityShaderNav は次のファイルで有効になります。

- `.shader`
- `.hlsl`
- `.cginc`
- `.hlslinc`
- `.compute`

単独の HLSL ファイルでは同一ファイル内のナビゲーションが使えます。完全なクロスファイルナビゲーションには、`Assets/` と `ProjectSettings/` を含む Unity project root が必要です。

## インストール

### 方法 1: Releases から VSIX をダウンロードする

1. [latest release](https://github.com/YukiagoTpf/UnityShaderNav/releases/latest) を開きます。
2. release assets から `unity-shader-nav-*.vsix` をダウンロードします。
3. VS Code で Extensions ビューを開きます。
4. `...` -> `Install from VSIX...` を選びます。
5. ダウンロードした VSIX ファイルを選択します。

インストール後、Unity プロジェクトを開き、`.shader`、`.hlsl`、`.cginc`、`.hlslinc`、または `.compute` ファイルを開いてください。

### 方法 2: ソースからビルドする

拡張機能を開発する場合や、ローカルで VSIX をパッケージする場合はこちらを使います。

必要なもの:

- VS Code 1.85 以降
- Node.js 18 以降
- npm

```powershell
cd unity-shader-nav
npm install
npm run build
```

ソースから拡張機能を実行する手順:

1. VS Code で `unity-shader-nav/` を開きます。
2. F5 を押し、拡張機能の起動構成を選択します。
3. Extension Development Host で Unity プロジェクトを開きます。
4. `.shader`、`.hlsl`、`.cginc`、`.hlslinc`、または `.compute` ファイルを開きます。

ローカルで VSIX をパッケージする場合:

```powershell
cd unity-shader-nav
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
- [Roadmap](docs/roadmap.md)
- [Technical Spec](docs/technical-spec.md)
- [Architecture Decision Records](docs/adr/)

## 既知の制限

- プリプロセッサ条件は評価しません。複数の有効な定義がある場合は、VS Code の Peek Definition に複数候補として返します。
- マクロ本体は展開しません。組み込みおよびユーザー設定の declaration patterns により、一般的な Unity マクロ宣言を扱います。
- Surface Shader の暗黙パラメータや ShaderGraph 生成コードは、特別なソースとしてインデックスしません。
- 組み込み補完とシグネチャヘルプは厳選された非網羅的な語彙です。プロジェクトシンボルと組み込み名が衝突する場合は、プロジェクトシンボルを優先します。
- Chain lookup は、複数行 receiver、マクロ展開 receiver、分岐依存の型、overload-specific return type inference などに対して保守的に動作します。

## コントリビュート

bug report、最小再現、小さな PR を歓迎します。まず [CONTRIBUTING.md](CONTRIBUTING.md) を読み、現在の [issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues) を確認してください。

## ライセンス

UnityShaderNav は [MIT License](LICENSE) のもとで公開されています。
