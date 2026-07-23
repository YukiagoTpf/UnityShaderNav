using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace UnityShaderNav.Adapter
{
    internal static class AdapterMaterialContext
    {
        internal const string Capability = "material-context";
        internal const int Version = 1;
        internal const string GetSelectedMethod =
            "get-selected-material-context";
        internal const string SelectionChangedEvent = "selection-changed";

        internal static AdapterCapabilityResponse Handle(string method)
        {
            if (!string.Equals(
                method,
                GetSelectedMethod,
                StringComparison.Ordinal))
            {
                return AdapterCapabilityResponse.Failure(
                    "method-not-found",
                    "Material Context does not support this method.");
            }

            return AdapterCapabilityResponse.Success(CreateSnapshotJson());
        }

        private static string CreateSnapshotJson()
        {
            var material = Selection.activeObject as Material;
            if (material == null)
            {
                return "{\"status\":\"none\"}";
            }

            var materialAsset = ReadAsset(
                material.name,
                AssetDatabase.GetAssetPath(material));
            var shader = material.shader;
            var shaderAsset = shader == null
                ? null
                : ReadAsset(shader.name, AssetDatabase.GetAssetPath(shader));
            if (materialAsset == null || shaderAsset == null)
            {
                return "{\"status\":\"none\"}";
            }

            var selectionId = AdapterJson.Sha256(
                materialAsset.Guid
                + "\0"
                + materialAsset.ContentHash
                + "\0"
                + shaderAsset.Guid
                + "\0"
                + shaderAsset.ContentHash);
            var builder = new StringBuilder(2048);
            builder.Append("{\"status\":\"selected\",\"selectionId\":");
            builder.Append(AdapterJson.Quote(selectionId));
            builder.Append(",\"collectedAt\":");
            builder.Append(AdapterJson.Number(AdapterJson.UnixMilliseconds()));
            builder.Append(",\"material\":");
            AppendAsset(builder, materialAsset);
            builder.Append(",\"shader\":");
            AppendAsset(builder, shaderAsset);
            builder.Append(",\"properties\":[");
            AppendProperties(builder, material, shader);
            builder.Append("],\"textures\":[");
            AppendTextures(builder, material, shader);
            builder.Append("],\"materialKeywords\":[");
            AppendKeywords(builder, material);
            builder.Append("]}");
            return builder.ToString();
        }

        private static AssetSnapshot ReadAsset(string name, string assetPath)
        {
            if (
                string.IsNullOrWhiteSpace(assetPath)
                || (
                    !assetPath.StartsWith("Assets/", StringComparison.Ordinal)
                    && !assetPath.StartsWith(
                        "Packages/",
                        StringComparison.Ordinal)
                )
            )
            {
                return null;
            }

            var fullPath = Path.GetFullPath(assetPath);
            if (!File.Exists(fullPath))
            {
                return null;
            }
            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            if (string.IsNullOrWhiteSpace(guid))
            {
                return null;
            }
            var bytes = File.ReadAllBytes(fullPath);
            return new AssetSnapshot(
                name,
                assetPath.Replace('\\', '/'),
                new Uri(fullPath).AbsoluteUri,
                guid.ToLowerInvariant(),
                AdapterJson.Sha256(bytes));
        }

        private static void AppendAsset(
            StringBuilder builder,
            AssetSnapshot asset)
        {
            builder.Append("{\"name\":");
            builder.Append(AdapterJson.Quote(asset.Name));
            builder.Append(",\"path\":");
            builder.Append(AdapterJson.Quote(asset.Path));
            builder.Append(",\"revision\":{\"uri\":");
            builder.Append(AdapterJson.Quote(asset.Uri));
            builder.Append(",\"assetGuid\":");
            builder.Append(AdapterJson.Quote(asset.Guid));
            builder.Append(",\"contentHash\":");
            builder.Append(AdapterJson.Quote(asset.ContentHash));
            builder.Append("}}");
        }

        private static void AppendProperties(
            StringBuilder builder,
            Material material,
            Shader shader)
        {
            var first = true;
            var count = ShaderUtil.GetPropertyCount(shader);
            for (var index = 0; index < count; index++)
            {
                var name = ShaderUtil.GetPropertyName(shader, index);
                if (!material.HasProperty(name))
                {
                    continue;
                }
                var shaderType = ShaderUtil
                    .GetPropertyType(shader, index)
                    .ToString();
                string bucket;
                string serializedValue;
                switch (shaderType)
                {
                    case "Color":
                    {
                        bucket = "vector";
                        var value = material.GetColor(name);
                        serializedValue = Vector4Json(value);
                        break;
                    }
                    case "Vector":
                        bucket = "vector";
                        serializedValue = Vector4Json(
                            material.GetVector(name));
                        break;
                    case "Int":
                        bucket = "integer";
                        serializedValue = AdapterJson.Number(
                            material.GetInt(name));
                        break;
                    case "TexEnv":
                    case "Texture":
                        bucket = "texture";
                        serializedValue = TextureValueJson(material, name);
                        break;
                    case "Float":
                    case "Range":
                    default:
                        bucket = "float";
                        serializedValue = AdapterJson.Number(
                            material.GetFloat(name));
                        break;
                }

                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                builder.Append("{\"name\":");
                builder.Append(AdapterJson.Quote(name));
                builder.Append(",\"type\":");
                builder.Append(AdapterJson.Quote(bucket));
                builder.Append(",\"serializedValue\":");
                builder.Append(serializedValue);
                builder.Append('}');
            }
        }

        private static void AppendTextures(
            StringBuilder builder,
            Material material,
            Shader shader)
        {
            var first = true;
            var count = ShaderUtil.GetPropertyCount(shader);
            for (var index = 0; index < count; index++)
            {
                var shaderType = ShaderUtil
                    .GetPropertyType(shader, index)
                    .ToString();
                if (
                    !string.Equals(shaderType, "TexEnv", StringComparison.Ordinal)
                    && !string.Equals(
                        shaderType,
                        "Texture",
                        StringComparison.Ordinal)
                )
                {
                    continue;
                }
                var propertyName = ShaderUtil.GetPropertyName(shader, index);
                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                builder.Append("{\"propertyName\":");
                builder.Append(AdapterJson.Quote(propertyName));
                builder.Append(",\"texture\":");
                AppendTextureAsset(builder, material.GetTexture(propertyName));
                builder.Append('}');
            }
        }

        private static void AppendTextureAsset(
            StringBuilder builder,
            Texture texture)
        {
            if (texture == null)
            {
                builder.Append("null");
                return;
            }
            var path = AssetDatabase.GetAssetPath(texture);
            var guid = string.IsNullOrWhiteSpace(path)
                ? null
                : AssetDatabase.AssetPathToGUID(path);
            if (string.IsNullOrWhiteSpace(guid))
            {
                builder.Append("null");
                return;
            }
            builder.Append("{\"name\":");
            builder.Append(AdapterJson.Quote(texture.name));
            builder.Append(",\"guid\":");
            builder.Append(AdapterJson.Quote(guid.ToLowerInvariant()));
            builder.Append(",\"path\":");
            builder.Append(AdapterJson.Quote(path.Replace('\\', '/')));
            builder.Append('}');
        }

        private static string TextureValueJson(
            Material material,
            string propertyName)
        {
            var texture = material.GetTexture(propertyName);
            var path = texture == null
                ? null
                : AssetDatabase.GetAssetPath(texture);
            var guid = string.IsNullOrWhiteSpace(path)
                ? null
                : AssetDatabase.AssetPathToGUID(path);
            var scale = material.GetTextureScale(propertyName);
            var offset = material.GetTextureOffset(propertyName);
            return "{\"guid\":"
                + AdapterJson.Quote(guid)
                + ",\"path\":"
                + AdapterJson.Quote(path)
                + ",\"scale\":["
                + AdapterJson.Number(scale.x)
                + ","
                + AdapterJson.Number(scale.y)
                + "],\"offset\":["
                + AdapterJson.Number(offset.x)
                + ","
                + AdapterJson.Number(offset.y)
                + "]}";
        }

        private static void AppendKeywords(
            StringBuilder builder,
            Material material)
        {
            var local = new HashSet<string>(StringComparer.Ordinal);
            foreach (var keyword in material.enabledKeywords)
            {
                local.Add(keyword.name);
            }
            var names = material.shaderKeywords
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(name => name, StringComparer.Ordinal);
            var first = true;
            foreach (var name in names)
            {
                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                builder.Append("{\"name\":");
                builder.Append(AdapterJson.Quote(name));
                builder.Append(",\"enabled\":true,\"scope\":");
                builder.Append(AdapterJson.Quote(
                    local.Contains(name) ? "local" : "legacy"));
                builder.Append('}');
            }
        }

        private static string Vector4Json(Vector4 value)
        {
            return "["
                + AdapterJson.Number(value.x)
                + ","
                + AdapterJson.Number(value.y)
                + ","
                + AdapterJson.Number(value.z)
                + ","
                + AdapterJson.Number(value.w)
                + "]";
        }

        private sealed class AssetSnapshot
        {
            internal AssetSnapshot(
                string name,
                string path,
                string uri,
                string guid,
                string contentHash)
            {
                Name = name;
                Path = path;
                Uri = uri;
                Guid = guid;
                ContentHash = contentHash;
            }

            internal string Name { get; private set; }
            internal string Path { get; private set; }
            internal string Uri { get; private set; }
            internal string Guid { get; private set; }
            internal string ContentHash { get; private set; }
        }
    }
}
