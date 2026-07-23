using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Apple;
using UnityEngine.Rendering;

namespace UnityShaderNav.GpuCapturePrototype
{
    public static class GpuCapturePrototype
    {
        private const string ShaderAsset = "Assets/Shaders/CaptureProbe.shader";
        private const string SourceUri =
            "project://Assets/Shaders/CaptureProbe.shader";
        private const string ShaderContextId =
            "capture-probe-forward-fragment";
        private const string OutputDirectory =
            "Library/UnityShaderNavGpuCapture";

        public static void Capture()
        {
            if (SystemInfo.graphicsDeviceType != GraphicsDeviceType.Metal)
            {
                throw new InvalidOperationException(
                    "The prototype requires Unity to run with the Metal graphics API.");
            }
            if (!FrameCapture.IsDestinationSupported(
                FrameCaptureDestination.GPUTraceDocument))
            {
                throw new InvalidOperationException(
                    "This Unity/Xcode environment cannot write GPU Trace documents.");
            }

            Directory.CreateDirectory(OutputDirectory);
            var tracePath = Path.GetFullPath(
                Path.Combine(OutputDirectory, "CaptureProbe.gputrace"));
            DeletePath(tracePath);

            GameObject quad = null;
            Material material = null;
            RenderTexture target = null;
            CommandBuffer commands = null;
            try
            {
                var sourceBytes = File.ReadAllBytes(ShaderAsset);
                var sourceText = new UTF8Encoding(
                    encoderShouldEmitUTF8Identifier: false,
                    throwOnInvalidBytes: true).GetString(sourceBytes);
                var sourceHash = Sha256(sourceBytes);
                var entryPointRange = ExactTokenRange(sourceText, "frag");
                var captureLabel =
                    "UnityShaderNav Capture Probe "
                    + sourceHash.Substring(0, 12)
                    + " "
                    + ShaderContextId;

                AssetDatabase.ImportAsset(
                    ShaderAsset,
                    ImportAssetOptions.ForceSynchronousImport
                    | ImportAssetOptions.ForceUpdate);
                RequireSourceRevision(sourceBytes);

                var shader = Shader.Find("UnityShaderNav/CaptureProbe");
                if (shader == null)
                {
                    throw new InvalidOperationException(
                        "CaptureProbe Shader did not import.");
                }

                material = new Material(shader)
                {
                    name = "UnityShaderNav Capture Probe Material"
                };
                material.EnableKeyword("CAPTURE_TINT");

                quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
                quad.name = "UnityShaderNav Capture Probe";
                quad.GetComponent<Renderer>().sharedMaterial = material;

                target = new RenderTexture(
                    64,
                    64,
                    0,
                    RenderTextureFormat.ARGB32)
                {
                    name = "UnityShaderNav Capture Probe Target"
                };
                target.Create();

                commands = new CommandBuffer
                {
                    name = captureLabel
                };
                commands.SetRenderTarget(target);
                commands.ClearRenderTarget(
                    clearDepth: false,
                    clearColor: true,
                    backgroundColor: Color.black);
                commands.DrawMesh(
                    quad.GetComponent<MeshFilter>().sharedMesh,
                    Matrix4x4.identity,
                    material,
                    submeshIndex: 0,
                    shaderPass: 0);

                FrameCapture.BeginCaptureToFile(tracePath);
                Graphics.ExecuteCommandBuffer(commands);
                FrameCapture.EndCapture();

                RequireSourceRevision(sourceBytes);
                var trace = HashTrace(tracePath);
                var evidence = BuildEvidence(
                    sourceText,
                    sourceHash,
                    entryPointRange,
                    captureLabel,
                    trace.sha256,
                    trace.byteLength);
                var evidencePath = Path.Combine(
                    OutputDirectory,
                    "CaptureProbe.evidence.json");
                File.WriteAllText(
                    evidencePath,
                    JsonUtility.ToJson(evidence, true) + "\n",
                    new UTF8Encoding(false));
                Debug.Log(
                    "[UnityShaderNav GPU capture] wrote "
                    + tracePath
                    + " and "
                    + Path.GetFullPath(evidencePath));
            }
            finally
            {
                if (commands != null)
                {
                    commands.Release();
                }
                if (target != null)
                {
                    target.Release();
                    UnityEngine.Object.DestroyImmediate(target);
                }
                if (quad != null)
                {
                    UnityEngine.Object.DestroyImmediate(quad);
                }
                if (material != null)
                {
                    UnityEngine.Object.DestroyImmediate(material);
                }
            }
        }

        private static Evidence BuildEvidence(
            string sourceText,
            string sourceHash,
            TokenRange entryPointRange,
            string captureLabel,
            string traceHash,
            long traceByteLength)
        {
            var xcodeVersion = RequiredEnvironment("USN_XCODE_VERSION");
            var xcodeBuild = RequiredEnvironment("USN_XCODE_BUILD_VERSION");
            var macosVersion = RequiredEnvironment("USN_MACOS_VERSION");
            var macosBuild = RequiredEnvironment("USN_MACOS_BUILD_VERSION");
            var metalVersion = RequiredEnvironment("USN_METAL_VERSION");
            return new Evidence
            {
                schemaVersion = 1,
                provenance = new Provenance
                {
                    capability = "gpu-capture-correlation/v1",
                    adapterVersion = "prototype-1",
                    unityVersion = Application.unityVersion,
                    unityBinaryVersion = RequiredEnvironment(
                        "USN_UNITY_BINARY_VERSION"),
                    projectId = "gpu-capture-prototype",
                    instanceId = RequiredEnvironment(
                        "USN_CAPTURE_INSTANCE_ID"),
                    collectedAt = (long)(
                        DateTime.UtcNow
                        - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                    ).TotalMilliseconds,
                    platform = new Platform
                    {
                        operatingSystem = "macOS",
                        operatingSystemVersion =
                            macosVersion + " (" + macosBuild + ")",
                        architecture = "arm64"
                    },
                    gpu = new Gpu
                    {
                        name = SystemInfo.graphicsDeviceName,
                        driverVersion =
                            "OS build " + macosBuild + "; " + metalVersion
                    },
                    graphicsApi = "Metal",
                    tool = new Tool
                    {
                        name = "Xcode Metal Frame Debugger",
                        version = xcodeVersion,
                        buildVersion = xcodeBuild,
                        metalCompilerVersion = metalVersion,
                        traceFormat = "gputrace"
                    },
                    sourceRevision = new SourceRevision
                    {
                        uri = SourceUri,
                        assetGuid = AssetDatabase.AssetPathToGUID(ShaderAsset),
                        contentHash = sourceHash
                    }
                },
                draw = new Draw
                {
                    captureId =
                        "capture-probe-"
                        + sourceHash.Substring(0, 12)
                        + "-draw-0",
                    frameIndex = 0,
                    drawIndex = 0,
                    label = captureLabel,
                    trace = new Trace
                    {
                        storage = "local-ephemeral",
                        fileName = "CaptureProbe.gputrace",
                        sha256 = traceHash,
                        byteLength = traceByteLength
                    }
                },
                context = new Context
                {
                    id = ShaderContextId,
                    shaderName = "UnityShaderNav/CaptureProbe",
                    subShaderIndex = 0,
                    passIndex = 0,
                    passName = "Forward",
                    stage = "fragment",
                    entryPoint = "frag",
                    keywords = new Keywords
                    {
                        enabled = new[] { "CAPTURE_TINT" },
                        incomplete = true
                    }
                },
                mapping = new Mapping
                {
                    status = "mapped",
                    method = "adapter-exact-source-range",
                    uri = SourceUri,
                    range = new SourceRange
                    {
                        start = new Position
                        {
                            line = entryPointRange.line,
                            character = entryPointRange.start
                        },
                        end = new Position
                        {
                            line = entryPointRange.line,
                            character = entryPointRange.end
                        }
                    },
                    expectedText = "frag",
                    sourceEntryPoint = "frag"
                }
            };
        }

        private static void RequireSourceRevision(byte[] expected)
        {
            var current = File.ReadAllBytes(ShaderAsset);
            if (!expected.SequenceEqual(current))
            {
                throw new InvalidOperationException(
                    "CaptureProbe Shader source changed during capture.");
            }
        }

        private static string RequiredEnvironment(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new InvalidOperationException(
                    "Missing required environment variable " + name + ".");
            }
            return value.Trim();
        }

        private static TokenRange ExactTokenRange(string source, string token)
        {
            var matches = new List<TokenRange>();
            var lines = source.Replace("\r\n", "\n").Split('\n');
            for (var line = 0; line < lines.Length; line++)
            {
                var start = 0;
                while ((start = lines[line].IndexOf(
                    token,
                    start,
                    StringComparison.Ordinal)) >= 0)
                {
                    var before = start == 0 || !IsIdentifier(lines[line][start - 1]);
                    var end = start + token.Length;
                    var after = end == lines[line].Length
                        || !IsIdentifier(lines[line][end]);
                    if (before && after)
                    {
                        matches.Add(new TokenRange
                        {
                            line = line,
                            start = start,
                            end = end
                        });
                    }
                    start = end;
                }
            }
            if (matches.Count != 2)
            {
                throw new InvalidOperationException(
                    "Expected one #pragma and one declaration token for '"
                    + token
                    + "', found "
                    + matches.Count
                    + ".");
            }
            return matches.OrderBy(match => match.line).Last();
        }

        private static bool IsIdentifier(char value)
        {
            return char.IsLetterOrDigit(value) || value == '_';
        }

        private static (string sha256, long byteLength) HashTrace(string path)
        {
            if (File.Exists(path))
            {
                var bytes = File.ReadAllBytes(path);
                return (Sha256(bytes), bytes.LongLength);
            }
            if (!Directory.Exists(path))
            {
                throw new InvalidOperationException(
                    "FrameCapture did not produce " + path + ".");
            }
            var identity = new StringBuilder();
            long byteLength = 0;
            foreach (var file in Directory
                .GetFiles(path, "*", SearchOption.AllDirectories)
                .OrderBy(value => value, StringComparer.Ordinal))
            {
                var bytes = File.ReadAllBytes(file);
                byteLength += bytes.LongLength;
                identity.Append(
                    file.Substring(path.Length)
                        .Replace(Path.DirectorySeparatorChar, '/'));
                identity.Append('\0');
                identity.Append(Sha256(bytes));
                identity.Append('\n');
            }
            if (byteLength == 0)
            {
                throw new InvalidOperationException(
                    "FrameCapture produced an empty GPU Trace document.");
            }
            return (
                Sha256(Encoding.UTF8.GetBytes(identity.ToString())),
                byteLength);
        }

        private static string Sha256(byte[] bytes)
        {
            using (var algorithm = SHA256.Create())
            {
                return string.Concat(
                    algorithm.ComputeHash(bytes)
                        .Select(value => value.ToString("x2")));
            }
        }

        private static void DeletePath(string path)
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
            else if (Directory.Exists(path))
            {
                Directory.Delete(path, true);
            }
        }

        [Serializable]
        private sealed class Evidence
        {
            public int schemaVersion;
            public Provenance provenance;
            public Draw draw;
            public Context context;
            public Mapping mapping;
        }

        [Serializable]
        private sealed class Provenance
        {
            public string capability;
            public string adapterVersion;
            public string unityVersion;
            public string unityBinaryVersion;
            public string projectId;
            public string instanceId;
            public long collectedAt;
            public Platform platform;
            public Gpu gpu;
            public string graphicsApi;
            public Tool tool;
            public SourceRevision sourceRevision;
        }

        [Serializable]
        private sealed class Platform
        {
            public string operatingSystem;
            public string operatingSystemVersion;
            public string architecture;
        }

        [Serializable]
        private sealed class Gpu
        {
            public string name;
            public string driverVersion;
        }

        [Serializable]
        private sealed class Tool
        {
            public string name;
            public string version;
            public string buildVersion;
            public string metalCompilerVersion;
            public string traceFormat;
        }

        [Serializable]
        private sealed class SourceRevision
        {
            public string uri;
            public string assetGuid;
            public string contentHash;
        }

        [Serializable]
        private sealed class Draw
        {
            public string captureId;
            public int frameIndex;
            public int drawIndex;
            public string label;
            public Trace trace;
        }

        [Serializable]
        private sealed class Trace
        {
            public string storage;
            public string fileName;
            public string sha256;
            public long byteLength;
        }

        [Serializable]
        private sealed class Context
        {
            public string id;
            public string shaderName;
            public int subShaderIndex;
            public int passIndex;
            public string passName;
            public string stage;
            public string entryPoint;
            public Keywords keywords;
        }

        [Serializable]
        private sealed class Keywords
        {
            public string[] enabled;
            public bool incomplete;
        }

        [Serializable]
        private sealed class Mapping
        {
            public string status;
            public string method;
            public string uri;
            public SourceRange range;
            public string expectedText;
            public string sourceEntryPoint;
        }

        [Serializable]
        private sealed class SourceRange
        {
            public Position start;
            public Position end;
        }

        [Serializable]
        private sealed class Position
        {
            public int line;
            public int character;
        }

        private sealed class TokenRange
        {
            public int line;
            public int start;
            public int end;
        }
    }
}
