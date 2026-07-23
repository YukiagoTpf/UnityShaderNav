using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace UnityShaderNav.Adapter
{
    /// <summary>
    /// Renders one explicitly requested, persistent Material/pass into a
    /// repository-owned deterministic input. Every request is revalidated
    /// against current Editor state before any draw evidence is returned.
    /// </summary>
    internal sealed class AdapterVisualLab :
        IAdapterHostCapability,
        IAdapterHostInvalidationSource
    {
        private const string Feature = "visual-lab-render/v1";
        private const string DescribeMethod = "describe-preview-target";
        private const string RenderMethod = "render-preview";
        private const string RenderInput =
            "unity-shader-nav/fullscreen-triangle/v1";
        private const int Width = 64;
        private const int Height = 64;
        private const string RenderTargetFormat = "ARGBFloat";

        private EnvironmentSnapshot observedEnvironment;

        public string Capability
        {
            get { return Feature; }
        }

        public int Version
        {
            get { return 1; }
        }

        public AdapterCapabilityResponse Handle(
            string method,
            string requestJson)
        {
            if (string.Equals(method, DescribeMethod, StringComparison.Ordinal))
            {
                return Describe(requestJson);
            }
            if (string.Equals(method, RenderMethod, StringComparison.Ordinal))
            {
                return Render(requestJson);
            }
            return AdapterCapabilityResponse.Failure(
                "method-not-found",
                "Visual Lab does not support this method.");
        }

        public bool TryGetInvalidation(out string reason)
        {
            var current = EnvironmentSnapshot.Read();
            if (observedEnvironment == null)
            {
                observedEnvironment = current;
                reason = null;
                return false;
            }

            reason = observedEnvironment.ChangeReason(current);
            observedEnvironment = current;
            return reason != null;
        }

        private AdapterCapabilityResponse Describe(string requestJson)
        {
            DescribeEnvelope envelope;
            try
            {
                envelope = JsonUtility.FromJson<DescribeEnvelope>(requestJson);
            }
            catch (Exception)
            {
                return InvalidRequest();
            }

            if (envelope == null || envelope.@params == null)
            {
                return InvalidRequest();
            }

            TargetSnapshot target;
            string error;
            if (!TargetSnapshot.TryDescribe(
                envelope.@params.selection,
                out target,
                out error))
            {
                return AdapterCapabilityResponse.Failure(
                    "identity-mismatch",
                    error);
            }

            observedEnvironment = target.Environment;
            var builder = new StringBuilder(4096);
            builder.Append("{\"capability\":");
            builder.Append(AdapterJson.Quote(Feature));
            builder.Append(",\"target\":");
            target.AppendJson(builder);
            builder.Append('}');
            return AdapterCapabilityResponse.Success(builder.ToString());
        }

        private AdapterCapabilityResponse Render(string requestJson)
        {
            RenderEnvelope envelope;
            try
            {
                envelope = JsonUtility.FromJson<RenderEnvelope>(requestJson);
            }
            catch (Exception)
            {
                return InvalidRequest();
            }

            if (
                envelope == null
                || envelope.@params == null
                || (
                    !string.Equals(
                        envelope.@params.slot,
                        "before",
                        StringComparison.Ordinal)
                    && !string.Equals(
                        envelope.@params.slot,
                        "after",
                        StringComparison.Ordinal)
                )
                || envelope.@params.requestGeneration < 0
            )
            {
                return InvalidRequest();
            }

            TargetSnapshot target;
            string error;
            if (!TargetSnapshot.TryRevalidate(
                envelope.@params.target,
                out target,
                out error))
            {
                return AdapterCapabilityResponse.Failure(
                    "identity-mismatch",
                    error);
            }

            RenderEvidence evidence;
            if (!RenderEvidence.TryCapture(
                target.Material,
                target.PassIndex,
                out evidence,
                out error))
            {
                return AdapterCapabilityResponse.Failure(
                    "render-failed",
                    error);
            }

            observedEnvironment = target.Environment;
            var builder = new StringBuilder(
                evidence.PngBytes.Length * 2
                + evidence.MaskBytes.Length * 2
                + 8192);
            builder.Append("{\"capability\":");
            builder.Append(AdapterJson.Quote(Feature));
            builder.Append(",\"slot\":");
            builder.Append(AdapterJson.Quote(envelope.@params.slot));
            builder.Append(",\"requestGeneration\":");
            builder.Append(AdapterJson.Number(
                envelope.@params.requestGeneration));
            builder.Append(",\"target\":");
            target.AppendJson(builder);
            builder.Append(",\"capturedAt\":");
            builder.Append(AdapterJson.Number(AdapterJson.UnixMilliseconds()));
            builder.Append(",\"image\":{\"mediaType\":\"image/png\"");
            builder.Append(",\"encoding\":\"base64\",\"width\":");
            builder.Append(AdapterJson.Number(Width));
            builder.Append(",\"height\":");
            builder.Append(AdapterJson.Number(Height));
            builder.Append(",\"byteLength\":");
            builder.Append(AdapterJson.Number(evidence.PngBytes.Length));
            builder.Append(",\"sha256\":");
            builder.Append(AdapterJson.Quote(
                AdapterJson.Sha256(evidence.PngBytes)));
            builder.Append(",\"data\":");
            builder.Append(AdapterJson.Quote(
                Convert.ToBase64String(evidence.PngBytes)));
            builder.Append("},\"diagnostic\":{\"nanInfMask\":{");
            builder.Append("\"format\":\"r8\",\"origin\":\"top-left\"");
            builder.Append(",\"layout\":\"row-major\",\"encoding\":\"base64\"");
            builder.Append(",\"width\":");
            builder.Append(AdapterJson.Number(Width));
            builder.Append(",\"height\":");
            builder.Append(AdapterJson.Number(Height));
            builder.Append(",\"byteLength\":");
            builder.Append(AdapterJson.Number(evidence.MaskBytes.Length));
            builder.Append(",\"data\":");
            builder.Append(AdapterJson.Quote(
                Convert.ToBase64String(evidence.MaskBytes)));
            builder.Append(",\"nanPixelCount\":");
            builder.Append(AdapterJson.Number(evidence.NanPixelCount));
            builder.Append(",\"infinitePixelCount\":");
            builder.Append(AdapterJson.Number(evidence.InfinitePixelCount));
            builder.Append(",\"maskedPixelCount\":");
            builder.Append(AdapterJson.Number(
                evidence.NanPixelCount + evidence.InfinitePixelCount));
            builder.Append("}}}");
            return AdapterCapabilityResponse.Success(builder.ToString());
        }

        private static AdapterCapabilityResponse InvalidRequest()
        {
            return AdapterCapabilityResponse.Failure(
                "invalid-request",
                "Visual Lab request payload is incomplete or malformed.");
        }

        private sealed class TargetSnapshot
        {
            private TargetSnapshot(
                string selectionId,
                string contextRevision,
                AssetSnapshot material,
                AssetSnapshot source,
                ShaderContextSnapshot shaderContext,
                EnvironmentSnapshot environment,
                Material selectedMaterial)
            {
                SelectionId = selectionId;
                ContextRevision = contextRevision;
                MaterialAsset = material;
                SourceAsset = source;
                ShaderContext = shaderContext;
                Environment = environment;
                Material = selectedMaterial;
                PassIndex = shaderContext.PassIndex;
            }

            internal string SelectionId { get; private set; }
            internal string ContextRevision { get; private set; }
            internal AssetSnapshot MaterialAsset { get; private set; }
            internal AssetSnapshot SourceAsset { get; private set; }
            internal ShaderContextSnapshot ShaderContext { get; private set; }
            internal EnvironmentSnapshot Environment { get; private set; }
            internal Material Material { get; private set; }
            internal int PassIndex { get; private set; }

            internal static bool TryDescribe(
                SelectionInput selection,
                out TargetSnapshot target,
                out string error)
            {
                target = null;
                error = "The selected Material identity is no longer current.";
                if (!ValidSelectionShape(selection))
                {
                    return false;
                }

                Material material;
                AssetSnapshot materialAsset;
                AssetSnapshot shaderAsset;
                if (!TryReadSelected(
                    out material,
                    out materialAsset,
                    out shaderAsset))
                {
                    return false;
                }
                if (
                    !materialAsset.Matches(selection.material)
                    || !shaderAsset.Matches(selection.source)
                    || !AdapterMatches(selection.adapter)
                    || !string.Equals(
                        selection.requestedContext.shaderUri,
                        shaderAsset.Uri,
                        StringComparison.Ordinal)
                )
                {
                    return false;
                }

                var currentSelectionId = AdapterJson.Sha256(
                    materialAsset.Guid
                    + "\0"
                    + materialAsset.ContentHash
                    + "\0"
                    + shaderAsset.Guid
                    + "\0"
                    + shaderAsset.ContentHash);
                if (!string.Equals(
                    currentSelectionId,
                    selection.selectionId,
                    StringComparison.Ordinal))
                {
                    return false;
                }

                var actualKeywords = KeywordSnapshot.ReadMaterial(material);
                if (!KeywordSnapshot.MatchesSelection(
                    actualKeywords,
                    selection.materialKeywords))
                {
                    error = "Material keyword evidence changed.";
                    return false;
                }

                ShaderContextSnapshot shaderContext;
                if (!ShaderContextSnapshot.TryResolve(
                    material,
                    shaderAsset,
                    selection.requestedContext,
                    selection.selectedProgram,
                    actualKeywords,
                    out shaderContext,
                    out error))
                {
                    return false;
                }

                target = new TargetSnapshot(
                    selection.selectionId,
                    selection.contextRevision,
                    materialAsset,
                    shaderAsset,
                    shaderContext,
                    EnvironmentSnapshot.Read(),
                    material);
                return true;
            }

            internal static bool TryRevalidate(
                TargetInput requested,
                out TargetSnapshot target,
                out string error)
            {
                target = null;
                error = "The pinned Visual Lab target is no longer current.";
                if (!ValidTargetShape(requested))
                {
                    return false;
                }

                Material material;
                AssetSnapshot materialAsset;
                AssetSnapshot shaderAsset;
                if (!TryReadSelected(
                    out material,
                    out materialAsset,
                    out shaderAsset))
                {
                    return false;
                }
                if (
                    !materialAsset.Matches(requested.material)
                    || !shaderAsset.Matches(requested.source)
                    || !AdapterMatches(requested.adapter)
                )
                {
                    return false;
                }

                var selectionId = AdapterJson.Sha256(
                    materialAsset.Guid
                    + "\0"
                    + materialAsset.ContentHash
                    + "\0"
                    + shaderAsset.Guid
                    + "\0"
                    + shaderAsset.ContentHash);
                if (!string.Equals(
                    selectionId,
                    requested.selectionId,
                    StringComparison.Ordinal))
                {
                    return false;
                }

                var materialKeywords = KeywordSnapshot.ReadMaterial(material);
                ShaderContextSnapshot shaderContext;
                if (!ShaderContextSnapshot.TryRevalidate(
                    material,
                    shaderAsset,
                    requested.shaderContext,
                    materialKeywords,
                    out shaderContext,
                    out error))
                {
                    return false;
                }

                var environment = EnvironmentSnapshot.Read();
                if (!environment.Matches(requested))
                {
                    error = "The render pipeline, profile, or input changed.";
                    return false;
                }

                target = new TargetSnapshot(
                    requested.selectionId,
                    requested.contextRevision,
                    materialAsset,
                    shaderAsset,
                    shaderContext,
                    environment,
                    material);
                return true;
            }

            internal void AppendJson(StringBuilder builder)
            {
                builder.Append("{\"selectionId\":");
                builder.Append(AdapterJson.Quote(SelectionId));
                builder.Append(",\"contextRevision\":");
                builder.Append(AdapterJson.Quote(ContextRevision));
                builder.Append(",\"material\":");
                MaterialAsset.AppendJson(builder);
                builder.Append(",\"source\":");
                SourceAsset.AppendJson(builder);
                builder.Append(",\"shaderContext\":");
                ShaderContext.AppendJson(builder);
                Environment.AppendJson(builder);
                builder.Append('}');
            }

            private static bool ValidSelectionShape(SelectionInput selection)
            {
                return selection != null
                    && NonEmpty(selection.selectionId)
                    && NonEmpty(selection.contextRevision)
                    && selection.material != null
                    && selection.source != null
                    && selection.requestedContext != null
                    && selection.adapter != null
                    && selection.materialKeywords != null;
            }

            private static bool ValidTargetShape(TargetInput target)
            {
                return target != null
                    && NonEmpty(target.selectionId)
                    && NonEmpty(target.contextRevision)
                    && target.material != null
                    && target.source != null
                    && target.shaderContext != null
                    && target.pipeline != null
                    && target.profile != null
                    && target.profile.renderTarget != null
                    && target.adapter != null
                    && NonEmpty(target.colorSpace)
                    && NonEmpty(target.renderInputId);
            }

            private static bool TryReadSelected(
                out Material material,
                out AssetSnapshot materialAsset,
                out AssetSnapshot shaderAsset)
            {
                material = Selection.activeObject as Material;
                materialAsset = null;
                shaderAsset = null;
                if (
                    material == null
                    || material.shader == null
                    || EditorUtility.IsDirty(material)
                )
                {
                    return false;
                }
                materialAsset = AssetSnapshot.Read(
                    material.name,
                    AssetDatabase.GetAssetPath(material));
                shaderAsset = AssetSnapshot.Read(
                    material.shader.name,
                    AssetDatabase.GetAssetPath(material.shader));
                return materialAsset != null && shaderAsset != null;
            }
        }

        private sealed class ShaderContextSnapshot
        {
            private ShaderContextSnapshot(
                string contextId,
                string shaderName,
                int subShaderIndex,
                int passIndex,
                string passName,
                string stage,
                string entryPoint,
                string[] materialKeywords,
                string[] globalKeywords)
            {
                ContextId = contextId;
                ShaderName = shaderName;
                SubShaderIndex = subShaderIndex;
                PassIndex = passIndex;
                PassName = passName;
                Stage = stage;
                EntryPoint = entryPoint;
                MaterialKeywords = materialKeywords;
                GlobalKeywords = globalKeywords;
            }

            internal string ContextId { get; private set; }
            internal string ShaderName { get; private set; }
            internal int SubShaderIndex { get; private set; }
            internal int PassIndex { get; private set; }
            internal string PassName { get; private set; }
            internal string Stage { get; private set; }
            internal string EntryPoint { get; private set; }
            internal string[] MaterialKeywords { get; private set; }
            internal string[] GlobalKeywords { get; private set; }

            internal static bool TryResolve(
                Material material,
                AssetSnapshot shaderAsset,
                RequestedContextInput requested,
                ProgramInput selectedProgram,
                string[] materialKeywords,
                out ShaderContextSnapshot result,
                out string error)
            {
                result = null;
                error = "The requested Shader Context cannot be rendered.";
                if (
                    requested == null
                    || !NonEmpty(requested.contextId)
                    || !NonEmpty(requested.shaderUri)
                    || !NonEmpty(requested.stage)
                    || !NonEmpty(requested.entryPoint)
                    || requested.subShaderIndex < 0
                    || (
                        requested.passIndex < 0
                        && !NonEmpty(requested.passName)
                    )
                )
                {
                    return false;
                }

                int passIndex;
                string passName;
                if (!TryResolvePass(
                    material,
                    requested.subShaderIndex,
                    requested.passIndex,
                    requested.passName,
                    out passIndex,
                    out passName,
                    out error))
                {
                    return false;
                }
                var hasSelectedProgram = selectedProgram != null
                    && (
                        selectedProgram.subShaderIndex >= 0
                        || selectedProgram.passIndex >= 0
                        || NonEmpty(selectedProgram.passName)
                    );
                if (
                    hasSelectedProgram
                    && (
                        selectedProgram.subShaderIndex < 0
                        ||
                        selectedProgram.subShaderIndex
                            != requested.subShaderIndex
                        || (
                            selectedProgram.passIndex >= 0
                            && selectedProgram.passIndex != passIndex
                        )
                        || (
                            NonEmpty(selectedProgram.passName)
                            && !string.Equals(
                                selectedProgram.passName,
                                passName,
                                StringComparison.Ordinal)
                        )
                    )
                )
                {
                    error = "The selected program and requested pass differ.";
                    return false;
                }
                if (!HasExplicitEntry(
                    shaderAsset.FullPath,
                    requested.stage,
                    requested.entryPoint))
                {
                    error = "The requested stage entry is not explicit in the saved Shader.";
                    return false;
                }

                result = new ShaderContextSnapshot(
                    requested.contextId,
                    material.shader.name,
                    requested.subShaderIndex,
                    passIndex,
                    passName,
                    requested.stage,
                    requested.entryPoint,
                    materialKeywords,
                    KeywordSnapshot.ReadGlobals());
                return true;
            }

            internal static bool TryRevalidate(
                Material material,
                AssetSnapshot shaderAsset,
                ShaderContextInput requested,
                string[] materialKeywords,
                out ShaderContextSnapshot result,
                out string error)
            {
                result = null;
                error = "The requested final draw Context is no longer current.";
                if (
                    requested == null
                    || !NonEmpty(requested.contextId)
                    || !string.Equals(
                        requested.shaderName,
                        material.shader.name,
                        StringComparison.Ordinal)
                    || requested.subShaderIndex < 0
                    || requested.passIndex < 0
                    || !NonEmpty(requested.stage)
                    || !NonEmpty(requested.entryPoint)
                    || requested.keywords == null
                    || requested.keywords.material == null
                    || requested.keywords.global == null
                    || requested.keywords.engineAdded == null
                )
                {
                    return false;
                }

                int passIndex;
                string passName;
                if (!TryResolvePass(
                    material,
                    requested.subShaderIndex,
                    requested.passIndex,
                    requested.passName,
                    out passIndex,
                    out passName,
                    out error))
                {
                    return false;
                }
                var globalKeywords = KeywordSnapshot.ReadGlobals();
                if (
                    !SameStrings(requested.keywords.material, materialKeywords)
                    || !SameStrings(requested.keywords.global, globalKeywords)
                    || requested.keywords.engineAdded.Length != 0
                    || !HasExplicitEntry(
                        shaderAsset.FullPath,
                        requested.stage,
                        requested.entryPoint)
                )
                {
                    error = "Final draw keyword or entry-point evidence changed.";
                    return false;
                }

                result = new ShaderContextSnapshot(
                    requested.contextId,
                    material.shader.name,
                    requested.subShaderIndex,
                    passIndex,
                    passName,
                    requested.stage,
                    requested.entryPoint,
                    materialKeywords,
                    globalKeywords);
                return true;
            }

            internal void AppendJson(StringBuilder builder)
            {
                builder.Append("{\"contextId\":");
                builder.Append(AdapterJson.Quote(ContextId));
                builder.Append(",\"shaderName\":");
                builder.Append(AdapterJson.Quote(ShaderName));
                builder.Append(",\"subShaderIndex\":");
                builder.Append(AdapterJson.Number(SubShaderIndex));
                builder.Append(",\"passIndex\":");
                builder.Append(AdapterJson.Number(PassIndex));
                if (NonEmpty(PassName))
                {
                    builder.Append(",\"passName\":");
                    builder.Append(AdapterJson.Quote(PassName));
                }
                builder.Append(",\"stage\":");
                builder.Append(AdapterJson.Quote(Stage));
                builder.Append(",\"entryPoint\":");
                builder.Append(AdapterJson.Quote(EntryPoint));
                builder.Append(",\"keywords\":{\"material\":");
                AppendStrings(builder, MaterialKeywords);
                builder.Append(",\"global\":");
                AppendStrings(builder, GlobalKeywords);
                builder.Append(",\"engineAdded\":[]}}");
            }

            private static bool TryResolvePass(
                Material material,
                int subShaderIndex,
                int requestedIndex,
                string requestedName,
                out int passIndex,
                out string passName,
                out string error)
            {
                passIndex = -1;
                passName = null;
                error = "The requested pass is unavailable.";

                // Unity's public runtime pass API exposes flattened pass
                // indices, not a stable subshader-to-pass map. Subshader zero
                // is therefore the only mapping this capability can prove
                // without guessing.
                if (subShaderIndex != 0)
                {
                    error = "Visual Lab cannot prove a non-zero subshader pass mapping.";
                    return false;
                }
                if (requestedIndex >= 0)
                {
                    if (requestedIndex >= material.passCount)
                    {
                        return false;
                    }
                    passIndex = requestedIndex;
                    passName = material.GetPassName(passIndex);
                    if (
                        NonEmpty(requestedName)
                        && !string.Equals(
                            requestedName,
                            passName,
                            StringComparison.Ordinal)
                    )
                    {
                        return false;
                    }
                    return true;
                }

                var matches = new List<int>();
                for (var index = 0; index < material.passCount; index++)
                {
                    if (string.Equals(
                        material.GetPassName(index),
                        requestedName,
                        StringComparison.Ordinal))
                    {
                        matches.Add(index);
                    }
                }
                if (matches.Count != 1)
                {
                    error = "The requested named pass is missing or ambiguous.";
                    return false;
                }
                passIndex = matches[0];
                passName = material.GetPassName(passIndex);
                return true;
            }

            private static bool HasExplicitEntry(
                string shaderPath,
                string stage,
                string entryPoint)
            {
                string pragma;
                switch (stage)
                {
                    case "vertex":
                    case "fragment":
                    case "geometry":
                    case "hull":
                    case "domain":
                        pragma = stage;
                        break;
                    default:
                        return false;
                }

                foreach (var rawLine in File.ReadLines(shaderPath))
                {
                    var line = rawLine;
                    var comment = line.IndexOf(
                        "//",
                        StringComparison.Ordinal);
                    if (comment >= 0)
                    {
                        line = line.Substring(0, comment);
                    }
                    var tokens = line
                        .Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                    if (
                        tokens.Length >= 3
                        && string.Equals(
                            tokens[0],
                            "#pragma",
                            StringComparison.Ordinal)
                        && string.Equals(
                            tokens[1],
                            pragma,
                            StringComparison.Ordinal)
                        && string.Equals(
                            tokens[2],
                            entryPoint,
                            StringComparison.Ordinal)
                    )
                    {
                        return true;
                    }
                }
                return false;
            }
        }

        private sealed class EnvironmentSnapshot
        {
            private EnvironmentSnapshot(
                PipelineSnapshot pipeline,
                ProfileSnapshot profile,
                string colorSpace,
                string renderInputId)
            {
                Pipeline = pipeline;
                Profile = profile;
                ColorSpace = colorSpace;
                RenderInputId = renderInputId;
            }

            internal PipelineSnapshot Pipeline { get; private set; }
            internal ProfileSnapshot Profile { get; private set; }
            internal string ColorSpace { get; private set; }
            internal string RenderInputId { get; private set; }

            internal static EnvironmentSnapshot Read()
            {
                return new EnvironmentSnapshot(
                    PipelineSnapshot.Read(),
                    ProfileSnapshot.Read(),
                    QualitySettings.activeColorSpace
                        == UnityEngine.ColorSpace.Linear
                        ? "linear"
                        : "gamma",
                    RenderInput);
            }

            internal string ChangeReason(EnvironmentSnapshot current)
            {
                if (!Pipeline.Equals(current.Pipeline))
                {
                    return "pipeline-changed";
                }
                if (!Profile.Equals(current.Profile))
                {
                    return "profile-changed";
                }
                if (!string.Equals(
                    ColorSpace,
                    current.ColorSpace,
                    StringComparison.Ordinal))
                {
                    return "color-space-changed";
                }
                if (!string.Equals(
                    RenderInputId,
                    current.RenderInputId,
                    StringComparison.Ordinal))
                {
                    return "render-input-changed";
                }
                return null;
            }

            internal bool Matches(TargetInput requested)
            {
                return Pipeline.Matches(requested.pipeline)
                    && Profile.Matches(requested.profile)
                    && string.Equals(
                        ColorSpace,
                        requested.colorSpace,
                        StringComparison.Ordinal)
                    && string.Equals(
                        RenderInputId,
                        requested.renderInputId,
                        StringComparison.Ordinal);
            }

            internal void AppendJson(StringBuilder builder)
            {
                builder.Append(",\"pipeline\":");
                Pipeline.AppendJson(builder);
                builder.Append(",\"profile\":");
                Profile.AppendJson(builder);
                builder.Append(",\"colorSpace\":");
                builder.Append(AdapterJson.Quote(ColorSpace));
                builder.Append(",\"adapter\":");
                AppendAdapter(builder);
                builder.Append(",\"renderInputId\":");
                builder.Append(AdapterJson.Quote(RenderInputId));
            }
        }

        private sealed class PipelineSnapshot
        {
            private PipelineSnapshot(
                string id,
                string kind,
                string name,
                string assetGuid,
                string contentHash)
            {
                Id = id;
                Kind = kind;
                Name = name;
                AssetGuid = assetGuid;
                ContentHash = contentHash;
            }

            internal string Id { get; private set; }
            internal string Kind { get; private set; }
            internal string Name { get; private set; }
            internal string AssetGuid { get; private set; }
            internal string ContentHash { get; private set; }

            internal static PipelineSnapshot Read()
            {
                var asset = GraphicsSettings.currentRenderPipeline;
                if (asset == null)
                {
                    return new PipelineSnapshot(
                        "built-in",
                        "built-in",
                        "Built-in Render Pipeline",
                        null,
                        null);
                }
                var snapshot = AssetSnapshot.Read(
                    asset.name,
                    AssetDatabase.GetAssetPath(asset));
                if (snapshot == null)
                {
                    throw new InvalidOperationException(
                        "The active render-pipeline asset is not persistent.");
                }
                return new PipelineSnapshot(
                    AdapterJson.Sha256(
                        "scriptable\0"
                        + snapshot.Guid
                        + "\0"
                        + snapshot.ContentHash),
                    "scriptable",
                    asset.name,
                    snapshot.Guid,
                    snapshot.ContentHash);
            }

            internal bool Matches(PipelineInput requested)
            {
                return requested != null
                    && string.Equals(Id, requested.id, StringComparison.Ordinal)
                    && string.Equals(
                        Kind,
                        requested.kind,
                        StringComparison.Ordinal)
                    && string.Equals(
                        Name,
                        requested.name,
                        StringComparison.Ordinal)
                    && string.Equals(
                        AssetGuid,
                        EmptyToNull(requested.assetGuid),
                        StringComparison.Ordinal)
                    && string.Equals(
                        ContentHash,
                        EmptyToNull(requested.contentHash),
                        StringComparison.Ordinal);
            }

            public override bool Equals(object other)
            {
                var value = other as PipelineSnapshot;
                return value != null
                    && string.Equals(Id, value.Id, StringComparison.Ordinal)
                    && string.Equals(
                        ContentHash,
                        value.ContentHash,
                        StringComparison.Ordinal);
            }

            public override int GetHashCode()
            {
                return Id.GetHashCode();
            }

            internal void AppendJson(StringBuilder builder)
            {
                builder.Append("{\"id\":");
                builder.Append(AdapterJson.Quote(Id));
                builder.Append(",\"kind\":");
                builder.Append(AdapterJson.Quote(Kind));
                builder.Append(",\"name\":");
                builder.Append(AdapterJson.Quote(Name));
                if (AssetGuid != null)
                {
                    builder.Append(",\"assetGuid\":");
                    builder.Append(AdapterJson.Quote(AssetGuid));
                    builder.Append(",\"contentHash\":");
                    builder.Append(AdapterJson.Quote(ContentHash));
                }
                builder.Append('}');
            }
        }

        private sealed class ProfileSnapshot
        {
            private ProfileSnapshot(
                string id,
                string buildTarget,
                string graphicsApi,
                int qualityLevel)
            {
                Id = id;
                BuildTarget = buildTarget;
                GraphicsApi = graphicsApi;
                QualityLevel = qualityLevel;
            }

            internal string Id { get; private set; }
            internal string BuildTarget { get; private set; }
            internal string GraphicsApi { get; private set; }
            internal int QualityLevel { get; private set; }

            internal static ProfileSnapshot Read()
            {
                var buildTarget =
                    EditorUserBuildSettings.activeBuildTarget.ToString();
                var graphicsApi = SystemInfo.graphicsDeviceType.ToString();
                var quality = QualitySettings.GetQualityLevel();
                return new ProfileSnapshot(
                    AdapterJson.Sha256(
                        buildTarget
                        + "\0"
                        + graphicsApi
                        + "\0"
                        + quality
                        + "\0"
                        + Width
                        + "x"
                        + Height
                        + "\0"
                        + RenderTargetFormat),
                    buildTarget,
                    graphicsApi,
                    quality);
            }

            internal bool Matches(ProfileInput requested)
            {
                return requested != null
                    && requested.renderTarget != null
                    && string.Equals(Id, requested.id, StringComparison.Ordinal)
                    && string.Equals(
                        BuildTarget,
                        requested.buildTarget,
                        StringComparison.Ordinal)
                    && string.Equals(
                        GraphicsApi,
                        requested.graphicsApi,
                        StringComparison.Ordinal)
                    && QualityLevel == requested.qualityLevel
                    && requested.renderTarget.width == Width
                    && requested.renderTarget.height == Height
                    && string.Equals(
                        RenderTargetFormat,
                        requested.renderTarget.format,
                        StringComparison.Ordinal);
            }

            public override bool Equals(object other)
            {
                var value = other as ProfileSnapshot;
                return value != null
                    && string.Equals(Id, value.Id, StringComparison.Ordinal);
            }

            public override int GetHashCode()
            {
                return Id.GetHashCode();
            }

            internal void AppendJson(StringBuilder builder)
            {
                builder.Append("{\"id\":");
                builder.Append(AdapterJson.Quote(Id));
                builder.Append(",\"buildTarget\":");
                builder.Append(AdapterJson.Quote(BuildTarget));
                builder.Append(",\"graphicsApi\":");
                builder.Append(AdapterJson.Quote(GraphicsApi));
                builder.Append(",\"qualityLevel\":");
                builder.Append(AdapterJson.Number(QualityLevel));
                builder.Append(",\"renderTarget\":{\"width\":");
                builder.Append(AdapterJson.Number(Width));
                builder.Append(",\"height\":");
                builder.Append(AdapterJson.Number(Height));
                builder.Append(",\"format\":");
                builder.Append(AdapterJson.Quote(RenderTargetFormat));
                builder.Append("}}");
            }
        }

        private sealed class AssetSnapshot
        {
            private AssetSnapshot(
                string name,
                string path,
                string fullPath,
                string uri,
                string guid,
                string contentHash)
            {
                Name = name;
                Path = path;
                FullPath = fullPath;
                Uri = uri;
                Guid = guid;
                ContentHash = contentHash;
            }

            internal string Name { get; private set; }
            internal string Path { get; private set; }
            internal string FullPath { get; private set; }
            internal string Uri { get; private set; }
            internal string Guid { get; private set; }
            internal string ContentHash { get; private set; }

            internal static AssetSnapshot Read(string name, string assetPath)
            {
                if (
                    !NonEmpty(assetPath)
                    || (
                        !assetPath.StartsWith(
                            "Assets/",
                            StringComparison.Ordinal)
                        && !assetPath.StartsWith(
                            "Packages/",
                            StringComparison.Ordinal)
                    )
                )
                {
                    return null;
                }
                var fullPath = ResolveAssetPath(assetPath);
                if (fullPath == null || !File.Exists(fullPath))
                {
                    return null;
                }
                var guid = AssetDatabase.AssetPathToGUID(assetPath);
                if (!NonEmpty(guid))
                {
                    return null;
                }
                return new AssetSnapshot(
                    name,
                    assetPath.Replace('\\', '/'),
                    fullPath,
                    new Uri(fullPath).AbsoluteUri,
                    guid.ToLowerInvariant(),
                    AdapterJson.Sha256(File.ReadAllBytes(fullPath)));
            }

            internal bool Matches(AssetInput requested)
            {
                return requested != null
                    && requested.revision != null
                    && string.Equals(
                        Name,
                        requested.name,
                        StringComparison.Ordinal)
                    && string.Equals(
                        Path,
                        requested.path,
                        StringComparison.Ordinal)
                    && string.Equals(
                        Uri,
                        requested.revision.uri,
                        StringComparison.Ordinal)
                    && string.Equals(
                        Guid,
                        requested.revision.assetGuid,
                        StringComparison.Ordinal)
                    && string.Equals(
                        ContentHash,
                        requested.revision.contentHash,
                        StringComparison.Ordinal);
            }

            internal void AppendJson(StringBuilder builder)
            {
                builder.Append("{\"name\":");
                builder.Append(AdapterJson.Quote(Name));
                builder.Append(",\"path\":");
                builder.Append(AdapterJson.Quote(Path));
                builder.Append(",\"revision\":{\"uri\":");
                builder.Append(AdapterJson.Quote(Uri));
                builder.Append(",\"assetGuid\":");
                builder.Append(AdapterJson.Quote(Guid));
                builder.Append(",\"contentHash\":");
                builder.Append(AdapterJson.Quote(ContentHash));
                builder.Append("}}");
            }

            private static string ResolveAssetPath(string assetPath)
            {
                if (assetPath.StartsWith("Assets/", StringComparison.Ordinal))
                {
                    return System.IO.Path.GetFullPath(assetPath);
                }
                var package = UnityEditor.PackageManager.PackageInfo
                    .FindForAssetPath(assetPath);
                if (
                    package == null
                    || !NonEmpty(package.resolvedPath)
                    || !assetPath.StartsWith(
                        "Packages/" + package.name,
                        StringComparison.Ordinal)
                )
                {
                    return null;
                }
                var relative = assetPath.Substring(
                    ("Packages/" + package.name).Length)
                    .TrimStart('/');
                return System.IO.Path.GetFullPath(
                    System.IO.Path.Combine(package.resolvedPath, relative));
            }
        }

        private static class KeywordSnapshot
        {
            internal static string[] ReadMaterial(Material material)
            {
                return material.shaderKeywords
                    .Where(NonEmpty)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray();
            }

            internal static string[] ReadGlobals()
            {
                var property = typeof(Shader).GetProperty(
                    "enabledGlobalKeywords",
                    BindingFlags.Public | BindingFlags.Static);
                if (property == null)
                {
                    return new string[0];
                }
                var values = property.GetValue(null, null) as IEnumerable;
                if (values == null)
                {
                    return new string[0];
                }
                var names = new List<string>();
                foreach (var value in values)
                {
                    if (value == null)
                    {
                        continue;
                    }
                    var text = value as string;
                    if (text == null)
                    {
                        var name = value.GetType().GetProperty(
                            "name",
                            BindingFlags.Public | BindingFlags.Instance);
                        text = name == null
                            ? null
                            : name.GetValue(value, null) as string;
                    }
                    if (NonEmpty(text))
                    {
                        names.Add(text);
                    }
                }
                return names
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray();
            }

            internal static bool MatchesSelection(
                string[] actual,
                KeywordInput[] requested)
            {
                if (requested == null)
                {
                    return false;
                }
                var enabled = new List<string>();
                var previous = string.Empty;
                foreach (var keyword in requested)
                {
                    if (
                        keyword == null
                        || !NonEmpty(keyword.name)
                        || (
                            !string.Equals(
                                keyword.scope,
                                "local",
                                StringComparison.Ordinal)
                            && !string.Equals(
                                keyword.scope,
                                "legacy",
                                StringComparison.Ordinal)
                        )
                    )
                    {
                        return false;
                    }
                    var key = keyword.scope + "\0" + keyword.name;
                    if (
                        previous.Length > 0
                        && string.CompareOrdinal(previous, key) >= 0
                    )
                    {
                        return false;
                    }
                    previous = key;
                    if (keyword.enabled)
                    {
                        enabled.Add(keyword.name);
                    }
                }
                return SameStrings(
                    actual,
                    enabled
                        .Distinct(StringComparer.Ordinal)
                        .OrderBy(value => value, StringComparer.Ordinal)
                        .ToArray());
            }
        }

        private sealed class RenderEvidence
        {
            private RenderEvidence(
                byte[] pngBytes,
                byte[] maskBytes,
                int nanPixelCount,
                int infinitePixelCount)
            {
                PngBytes = pngBytes;
                MaskBytes = maskBytes;
                NanPixelCount = nanPixelCount;
                InfinitePixelCount = infinitePixelCount;
            }

            internal byte[] PngBytes { get; private set; }
            internal byte[] MaskBytes { get; private set; }
            internal int NanPixelCount { get; private set; }
            internal int InfinitePixelCount { get; private set; }

            internal static bool TryCapture(
                Material material,
                int passIndex,
                out RenderEvidence evidence,
                out string error)
            {
                evidence = null;
                error = "Unity could not render the controlled preview.";
                if (!SystemInfo.SupportsRenderTextureFormat(
                    RenderTextureFormat.ARGBFloat))
                {
                    error = "ARGBFloat render targets are unsupported.";
                    return false;
                }

                RenderTexture target = null;
                Texture2D readback = null;
                Texture2D preview = null;
                var previousActive = RenderTexture.active;
                var previousSrgbWrite = GL.sRGBWrite;
                try
                {
                    target = new RenderTexture(
                        Width,
                        Height,
                        0,
                        RenderTextureFormat.ARGBFloat,
                        RenderTextureReadWrite.Linear)
                    {
                        name = "UnityShaderNav.VisualLab",
                        antiAliasing = 1,
                        filterMode = FilterMode.Point,
                        wrapMode = TextureWrapMode.Clamp,
                        hideFlags = HideFlags.HideAndDontSave
                    };
                    if (!target.Create())
                    {
                        return false;
                    }

                    RenderTexture.active = target;
                    GL.sRGBWrite = false;
                    GL.Clear(true, true, Color.clear);
                    GL.PushMatrix();
                    try
                    {
                        GL.LoadProjectionMatrix(Matrix4x4.identity);
                        GL.modelview = Matrix4x4.identity;
                        if (!material.SetPass(passIndex))
                        {
                            error = "Unity rejected the requested Material pass.";
                            return false;
                        }
                        GL.Begin(GL.TRIANGLES);
                        GL.Vertex3(-1.0f, -1.0f, 0.0f);
                        GL.Vertex3(3.0f, -1.0f, 0.0f);
                        GL.Vertex3(-1.0f, 3.0f, 0.0f);
                        GL.End();
                    }
                    finally
                    {
                        GL.PopMatrix();
                    }
                    GL.Flush();

                    readback = new Texture2D(
                        Width,
                        Height,
                        TextureFormat.RGBAFloat,
                        false,
                        true)
                    {
                        hideFlags = HideFlags.HideAndDontSave
                    };
                    readback.ReadPixels(
                        new Rect(0, 0, Width, Height),
                        0,
                        0,
                        false);
                    readback.Apply(false, false);
                    var colors = readback.GetPixels();
                    if (colors.Length != Width * Height)
                    {
                        return false;
                    }

                    var mask = new byte[Width * Height];
                    var sanitized = new Color[colors.Length];
                    var nanPixels = 0;
                    var infinitePixels = 0;
                    for (var y = 0; y < Height; y++)
                    {
                        for (var x = 0; x < Width; x++)
                        {
                            var bottomIndex = y * Width + x;
                            var topIndex = (Height - 1 - y) * Width + x;
                            var color = colors[bottomIndex];
                            var hasNan = float.IsNaN(color.r)
                                || float.IsNaN(color.g)
                                || float.IsNaN(color.b)
                                || float.IsNaN(color.a);
                            var hasInfinity = !hasNan
                                && (
                                    float.IsInfinity(color.r)
                                    || float.IsInfinity(color.g)
                                    || float.IsInfinity(color.b)
                                    || float.IsInfinity(color.a)
                                );
                            if (hasNan)
                            {
                                mask[topIndex] = 255;
                                nanPixels++;
                            }
                            else if (hasInfinity)
                            {
                                mask[topIndex] = 255;
                                infinitePixels++;
                            }
                            sanitized[bottomIndex] = new Color(
                                Sanitize(color.r),
                                Sanitize(color.g),
                                Sanitize(color.b),
                                Sanitize(color.a));
                        }
                    }

                    preview = new Texture2D(
                        Width,
                        Height,
                        TextureFormat.RGBA32,
                        false,
                        true)
                    {
                        hideFlags = HideFlags.HideAndDontSave
                    };
                    preview.SetPixels(sanitized);
                    preview.Apply(false, false);
                    var png = preview.EncodeToPNG();
                    if (png == null || png.Length == 0)
                    {
                        return false;
                    }
                    evidence = new RenderEvidence(
                        png,
                        mask,
                        nanPixels,
                        infinitePixels);
                    return true;
                }
                finally
                {
                    GL.sRGBWrite = previousSrgbWrite;
                    RenderTexture.active = previousActive;
                    if (preview != null)
                    {
                        UnityEngine.Object.DestroyImmediate(preview);
                    }
                    if (readback != null)
                    {
                        UnityEngine.Object.DestroyImmediate(readback);
                    }
                    if (target != null)
                    {
                        target.Release();
                        UnityEngine.Object.DestroyImmediate(target);
                    }
                }
            }

            private static float Sanitize(float value)
            {
                return float.IsNaN(value) || float.IsInfinity(value)
                    ? 0.0f
                    : Mathf.Clamp01(value);
            }
        }

        private static bool AdapterMatches(AdapterInput requested)
        {
            return requested != null
                && string.Equals(
                    requested.projectId,
                    AdapterHost.ProjectHash,
                    StringComparison.Ordinal)
                && string.Equals(
                    requested.instanceId,
                    AdapterHost.InstanceId,
                    StringComparison.Ordinal)
                && string.Equals(
                    requested.adapterVersion,
                    AdapterHost.AdapterVersion,
                    StringComparison.Ordinal)
                && string.Equals(
                    requested.unityVersion,
                    Application.unityVersion,
                    StringComparison.Ordinal);
        }

        private static void AppendAdapter(StringBuilder builder)
        {
            builder.Append("{\"projectId\":");
            builder.Append(AdapterJson.Quote(AdapterHost.ProjectHash));
            builder.Append(",\"instanceId\":");
            builder.Append(AdapterJson.Quote(AdapterHost.InstanceId));
            builder.Append(",\"adapterVersion\":");
            builder.Append(AdapterJson.Quote(AdapterHost.AdapterVersion));
            builder.Append(",\"unityVersion\":");
            builder.Append(AdapterJson.Quote(Application.unityVersion));
            builder.Append('}');
        }

        private static void AppendStrings(
            StringBuilder builder,
            IEnumerable<string> values)
        {
            builder.Append('[');
            var first = true;
            foreach (var value in values)
            {
                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                builder.Append(AdapterJson.Quote(value));
            }
            builder.Append(']');
        }

        private static bool SameStrings(
            string[] left,
            string[] right)
        {
            return left != null
                && right != null
                && left.Length == right.Length
                && left.SequenceEqual(right, StringComparer.Ordinal);
        }

        private static bool NonEmpty(string value)
        {
            return !string.IsNullOrWhiteSpace(value);
        }

        private static string EmptyToNull(string value)
        {
            return NonEmpty(value) ? value : null;
        }

        [Serializable]
        private sealed class DescribeEnvelope
        {
            public DescribeParams @params;
        }

        [Serializable]
        private sealed class DescribeParams
        {
            public SelectionInput selection;
        }

        [Serializable]
        private sealed class RenderEnvelope
        {
            public RenderParams @params;
        }

        [Serializable]
        private sealed class RenderParams
        {
            public string slot;
            public long requestGeneration = -1;
            public TargetInput target;
        }

        [Serializable]
        private sealed class SelectionInput
        {
            public string selectionId;
            public string contextRevision;
            public AssetInput material;
            public AssetInput source;
            public ProgramInput selectedProgram;
            public RequestedContextInput requestedContext;
            public KeywordInput[] materialKeywords;
            public AdapterInput adapter;
        }

        [Serializable]
        private sealed class TargetInput
        {
            public string selectionId;
            public string contextRevision;
            public AssetInput material;
            public AssetInput source;
            public ShaderContextInput shaderContext;
            public PipelineInput pipeline;
            public ProfileInput profile;
            public string colorSpace;
            public AdapterInput adapter;
            public string renderInputId;
        }

        [Serializable]
        private sealed class AssetInput
        {
            public string name;
            public string path;
            public RevisionInput revision;
        }

        [Serializable]
        private sealed class RevisionInput
        {
            public string uri;
            public string assetGuid;
            public string contentHash;
        }

        [Serializable]
        private sealed class ProgramInput
        {
            public int subShaderIndex = -1;
            public int passIndex = -1;
            public string passName;
        }

        [Serializable]
        private sealed class RequestedContextInput
        {
            public string contextId;
            public string shaderUri;
            public int subShaderIndex = -1;
            public int passIndex = -1;
            public string passName;
            public string stage;
            public string entryPoint;
        }

        [Serializable]
        private sealed class KeywordInput
        {
            public string name;
            public bool enabled;
            public string scope;
        }

        [Serializable]
        private sealed class ShaderContextInput
        {
            public string contextId;
            public string shaderName;
            public int subShaderIndex = -1;
            public int passIndex = -1;
            public string passName;
            public string stage;
            public string entryPoint;
            public DrawKeywordsInput keywords;
        }

        [Serializable]
        private sealed class DrawKeywordsInput
        {
            public string[] material;
            public string[] global;
            public string[] engineAdded;
        }

        [Serializable]
        private sealed class PipelineInput
        {
            public string id;
            public string kind;
            public string name;
            public string assetGuid;
            public string contentHash;
        }

        [Serializable]
        private sealed class ProfileInput
        {
            public string id;
            public string buildTarget;
            public string graphicsApi;
            public int qualityLevel = -1;
            public RenderTargetInput renderTarget;
        }

        [Serializable]
        private sealed class RenderTargetInput
        {
            public int width = -1;
            public int height = -1;
            public string format;
        }

        [Serializable]
        private sealed class AdapterInput
        {
            public string projectId;
            public string instanceId;
            public string adapterVersion;
            public string unityVersion;
        }
    }
}
