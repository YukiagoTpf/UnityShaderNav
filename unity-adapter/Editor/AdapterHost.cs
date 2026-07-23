using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace UnityShaderNav.Adapter
{
    [InitializeOnLoad]
    internal static class AdapterHost
    {
        private const int ProtocolVersion = 1;
        private const int MaximumFrameBytes = 8 * 1024 * 1024;
        private const int CurrentUserOnlyPipeOption = 0x20000000;
        private const string DescriptorRelativePath =
            "Library/UnityShaderNavAdapter/session.json";
        private static readonly UTF8Encoding Utf8 =
            new UTF8Encoding(false, true);
        private static readonly object LifecycleLock = new object();
        private static readonly object ActivePeerLock = new object();
        private static readonly ConcurrentQueue<RequestWork> Requests =
            new ConcurrentQueue<RequestWork>();
        private static readonly Dictionary<string, IAdapterHostCapability>
            Capabilities =
                new Dictionary<string, IAdapterHostCapability>(
                    StringComparer.Ordinal);

        private static volatile bool running;
        private static string projectRoot;
        private static string projectHash;
        private static string instanceId;
        private static string token;
        private static string endpoint;
        private static string endpointKind;
        private static string pipeName;
        private static string adapterVersion;
        private static Thread acceptThread;
        private static Socket unixListener;
        private static NamedPipeServerStream pendingPipe;
        private static ClientPeer activePeer;

        static AdapterHost()
        {
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
            EditorApplication.delayCall += Start;
        }

        internal static string ProjectHash
        {
            get { return projectHash; }
        }

        internal static string InstanceId
        {
            get { return instanceId; }
        }

        internal static string AdapterVersion
        {
            get { return adapterVersion; }
        }

        private static void Start()
        {
            lock (LifecycleLock)
            {
                if (running)
                {
                    return;
                }

                try
                {
                    projectRoot = Path.GetFullPath(
                        Path.Combine(Application.dataPath, ".."))
                        .TrimEnd(
                            Path.DirectorySeparatorChar,
                            Path.AltDirectorySeparatorChar);
                    projectHash = AdapterJson.Sha256(
                        CanonicalProjectIdentity(projectRoot));
                    instanceId = Guid.NewGuid().ToString("N");
                    token = RandomToken();
                    adapterVersion = ResolveAdapterVersion();
                    DiscoverCapabilities();
                    CreateEndpoint();
                    running = true;
                    WriteDescriptor();

                    Selection.selectionChanged += PublishSelectionChanged;
                    EditorApplication.projectChanged += PublishSelectionChanged;
                    Undo.undoRedoPerformed += PublishSelectionChanged;
                    EditorApplication.update += DrainRequests;

                    acceptThread = new Thread(AcceptLoop);
                    acceptThread.Name = "UnityShaderNav Adapter IPC";
                    acceptThread.IsBackground = true;
                    acceptThread.Start();
                }
                catch (Exception exception)
                {
                    UnityEngine.Debug.LogError(
                        "[UnityShaderNav Adapter] Failed to start local IPC: "
                        + exception);
                    StopLocked();
                }
            }
        }

        private static void Stop()
        {
            lock (LifecycleLock)
            {
                StopLocked();
            }
        }

        private static void StopLocked()
        {
            var wasRunning = running;
            running = false;
            Selection.selectionChanged -= PublishSelectionChanged;
            EditorApplication.projectChanged -= PublishSelectionChanged;
            Undo.undoRedoPerformed -= PublishSelectionChanged;
            EditorApplication.update -= DrainRequests;

            lock (ActivePeerLock)
            {
                if (activePeer != null)
                {
                    activePeer.Dispose();
                    activePeer = null;
                }
            }
            if (pendingPipe != null)
            {
                pendingPipe.Dispose();
                pendingPipe = null;
            }
            if (unixListener != null)
            {
                unixListener.Close();
                unixListener = null;
            }
            if (
                acceptThread != null
                && acceptThread != Thread.CurrentThread
                && acceptThread.IsAlive
            )
            {
                acceptThread.Join(500);
            }
            acceptThread = null;

            RequestWork ignored;
            while (Requests.TryDequeue(out ignored))
            {
            }
            RemoveOwnedDescriptor();
            RemoveUnixSocket();
            Capabilities.Clear();
            if (wasRunning)
            {
                UnityEngine.Debug.Log(
                    "[UnityShaderNav Adapter] Local IPC stopped.");
            }
        }

        private static void CreateEndpoint()
        {
            if (Application.platform == RuntimePlatform.WindowsEditor)
            {
                endpointKind = "named-pipe";
                pipeName = "UnityShaderNav-"
                    + projectHash.Substring(0, 16)
                    + "-"
                    + instanceId.Substring(0, 12);
                endpoint = @"\\.\pipe\" + pipeName;
                return;
            }

            endpointKind = "unix-domain-socket";
            var runtimeDirectory = Path.Combine(
                Path.GetTempPath(),
                "usn-" + EffectiveUserId());
            Directory.CreateDirectory(runtimeDirectory);
            Chmod(runtimeDirectory, Convert.ToInt32("700", 8));
            endpoint = Path.Combine(
                runtimeDirectory,
                projectHash.Substring(0, 12)
                + "-"
                + instanceId.Substring(0, 8)
                + ".sock");
            if (File.Exists(endpoint))
            {
                File.Delete(endpoint);
            }
            unixListener = new Socket(
                AddressFamily.Unix,
                SocketType.Stream,
                ProtocolType.Unspecified);
            unixListener.Bind(new UnixDomainSocketEndPoint(endpoint));
            Chmod(endpoint, Convert.ToInt32("600", 8));
            unixListener.Listen(1);
        }

        private static void AcceptLoop()
        {
            try
            {
                if (endpointKind == "named-pipe")
                {
                    AcceptNamedPipes();
                }
                else
                {
                    AcceptUnixSockets();
                }
            }
            catch (Exception exception)
            {
                if (running)
                {
                    UnityEngine.Debug.LogError(
                        "[UnityShaderNav Adapter] IPC listener failed: "
                        + exception);
                }
            }
        }

        private static void AcceptNamedPipes()
        {
            while (running)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = new NamedPipeServerStream(
                        pipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous
                            | (PipeOptions)CurrentUserOnlyPipeOption);
                    pendingPipe = pipe;
                    pipe.WaitForConnection();
                    pendingPipe = null;
                    ServeSafely(pipe);
                }
                catch (ObjectDisposedException)
                {
                    if (running)
                    {
                        throw;
                    }
                }
                catch (IOException)
                {
                    if (running)
                    {
                        throw;
                    }
                }
                finally
                {
                    pendingPipe = null;
                    if (pipe != null)
                    {
                        pipe.Dispose();
                    }
                }
            }
        }

        private static void AcceptUnixSockets()
        {
            while (running)
            {
                Socket socket = null;
                try
                {
                    socket = unixListener.Accept();
                    using (var stream = new NetworkStream(socket, true))
                    {
                        socket = null;
                        ServeSafely(stream);
                    }
                }
                catch (ObjectDisposedException)
                {
                    if (running)
                    {
                        throw;
                    }
                }
                catch (SocketException)
                {
                    if (running)
                    {
                        throw;
                    }
                }
                finally
                {
                    if (socket != null)
                    {
                        socket.Dispose();
                    }
                }
            }
        }

        private static void ServeSafely(Stream stream)
        {
            try
            {
                Serve(stream);
            }
            catch (Exception exception)
            {
                if (running)
                {
                    UnityEngine.Debug.LogWarning(
                        "[UnityShaderNav Adapter] Closed invalid local "
                        + "client stream: "
                        + exception.Message);
                }
            }
        }

        private static void Serve(Stream stream)
        {
            using (var peer = new ClientPeer(stream))
            {
                var helloJson = ReadFrame(stream);
                if (helloJson == null)
                {
                    return;
                }
                var hello = JsonUtility.FromJson<HelloMessage>(helloJson);
                var rejection = ValidateHello(hello);
                if (rejection != null)
                {
                    peer.WriteJson(
                        "{\"type\":\"reject\",\"reason\":"
                        + AdapterJson.Quote(rejection)
                        + "}");
                    return;
                }
                if (!peer.WriteJson(WelcomeJson()))
                {
                    return;
                }
                lock (ActivePeerLock)
                {
                    if (!running)
                    {
                        return;
                    }
                    activePeer = peer;
                }

                try
                {
                    while (running && peer.Alive)
                    {
                        var requestJson = ReadFrame(stream);
                        if (requestJson == null)
                        {
                            break;
                        }
                        var request = JsonUtility.FromJson<RequestMessage>(
                            requestJson);
                        if (
                            request == null
                            || request.type != "request"
                            || string.IsNullOrWhiteSpace(request.id)
                            || string.IsNullOrWhiteSpace(request.capability)
                            || string.IsNullOrWhiteSpace(request.method)
                        )
                        {
                            break;
                        }
                        Requests.Enqueue(
                            new RequestWork(peer, request, requestJson));
                    }
                }
                finally
                {
                    lock (ActivePeerLock)
                    {
                        if (ReferenceEquals(activePeer, peer))
                        {
                            activePeer = null;
                        }
                    }
                }
            }
        }

        private static string ValidateHello(HelloMessage hello)
        {
            if (
                hello == null
                || !string.Equals(
                    hello.type,
                    "hello",
                    StringComparison.Ordinal)
                || !ConstantTimeEquals(hello.token, token)
            )
            {
                return "token";
            }
            if (hello.protocolVersion != ProtocolVersion)
            {
                return "protocol";
            }
            if (!ConstantTimeEquals(hello.projectHash, projectHash))
            {
                return "project";
            }
            return null;
        }

        private static void DrainRequests()
        {
            var remaining = 64;
            RequestWork work;
            while (remaining-- > 0 && Requests.TryDequeue(out work))
            {
                if (!work.Peer.Alive)
                {
                    continue;
                }

                AdapterCapabilityResponse response;
                try
                {
                    if (
                        string.Equals(
                            work.Request.capability,
                            AdapterMaterialContext.Capability,
                            StringComparison.Ordinal)
                    )
                    {
                        response = AdapterMaterialContext.Handle(
                            work.Request.method);
                    }
                    else
                    {
                        IAdapterHostCapability capability;
                        if (!Capabilities.TryGetValue(
                            work.Request.capability,
                            out capability))
                        {
                            response = AdapterCapabilityResponse.Failure(
                                "capability-not-found",
                                "The requested Adapter capability is unavailable.");
                        }
                        else
                        {
                            response = capability.Handle(
                                work.Request.method,
                                work.RequestJson);
                        }
                    }
                }
                catch (Exception exception)
                {
                    response = AdapterCapabilityResponse.Failure(
                        "internal-error",
                        exception.Message);
                }
                work.Peer.WriteJson(
                    ResponseJson(work.Request.id, response));
            }
            PollCapabilityInvalidations();
        }

        private static void PollCapabilityInvalidations()
        {
            foreach (var pair in Capabilities)
            {
                var source = pair.Value as IAdapterHostInvalidationSource;
                if (source == null)
                {
                    continue;
                }
                try
                {
                    string reason;
                    if (
                        source.TryGetInvalidation(out reason)
                        && !string.IsNullOrWhiteSpace(reason)
                    )
                    {
                        PublishCapabilityEvent(
                            pair.Key,
                            "target-changed",
                            "{\"reason\":"
                            + AdapterJson.Quote(reason)
                            + "}");
                    }
                }
                catch (Exception exception)
                {
                    UnityEngine.Debug.LogWarning(
                        "[UnityShaderNav Adapter] Invalidation polling failed "
                        + "for "
                        + pair.Key
                        + ": "
                        + exception.Message);
                }
            }
        }

        private static void PublishSelectionChanged()
        {
            ClientPeer peer;
            lock (ActivePeerLock)
            {
                peer = activePeer;
            }
            if (peer == null)
            {
                return;
            }
            peer.WriteJson(
                "{\"type\":\"event\",\"capability\":"
                + AdapterJson.Quote(AdapterMaterialContext.Capability)
                + ",\"event\":"
                + AdapterJson.Quote(
                    AdapterMaterialContext.SelectionChangedEvent)
                + "}");
        }

        internal static bool PublishCapabilityEvent(
            string capability,
            string eventName,
            string payloadJson)
        {
            ClientPeer peer;
            lock (ActivePeerLock)
            {
                peer = activePeer;
            }
            if (peer == null)
            {
                return false;
            }
            var payload = string.IsNullOrWhiteSpace(payloadJson)
                ? string.Empty
                : ",\"payload\":" + payloadJson;
            return peer.WriteJson(
                "{\"type\":\"event\",\"capability\":"
                + AdapterJson.Quote(capability)
                + ",\"event\":"
                + AdapterJson.Quote(eventName)
                + payload
                + "}");
        }

        private static void DiscoverCapabilities()
        {
            Capabilities.Clear();
            foreach (
                var type in TypeCache
                    .GetTypesDerivedFrom<IAdapterHostCapability>()
                    .OrderBy(value => value.FullName, StringComparer.Ordinal)
            )
            {
                if (
                    type.IsAbstract
                    || type.IsInterface
                )
                {
                    continue;
                }
                try
                {
                    var capability =
                        (IAdapterHostCapability)Activator.CreateInstance(
                            type,
                            true);
                    if (
                        capability == null
                        || string.IsNullOrWhiteSpace(capability.Capability)
                        || capability.Version <= 0
                        || Capabilities.ContainsKey(capability.Capability)
                    )
                    {
                        UnityEngine.Debug.LogWarning(
                            "[UnityShaderNav Adapter] Ignored invalid or "
                            + "duplicate capability type "
                            + type.FullName
                            + ".");
                        continue;
                    }
                    Capabilities.Add(capability.Capability, capability);
                }
                catch (Exception exception)
                {
                    UnityEngine.Debug.LogWarning(
                        "[UnityShaderNav Adapter] Could not construct "
                        + type.FullName
                        + ": "
                        + exception.Message);
                }
            }
        }

        private static string WelcomeJson()
        {
            var entries = new List<CapabilityMessage>
            {
                new CapabilityMessage
                {
                    name = AdapterMaterialContext.Capability,
                    version = AdapterMaterialContext.Version
                }
            };
            entries.AddRange(
                Capabilities
                    .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                    .Select(pair => new CapabilityMessage
                    {
                        name = pair.Key,
                        version = pair.Value.Version
                    }));
            return JsonUtility.ToJson(new WelcomeMessage
            {
                type = "welcome",
                protocolVersion = ProtocolVersion,
                adapterVersion = adapterVersion,
                unityVersion = Application.unityVersion,
                projectHash = projectHash,
                instanceId = instanceId,
                capabilities = entries.ToArray()
            });
        }

        private static string ResponseJson(
            string id,
            AdapterCapabilityResponse response)
        {
            if (response.Ok)
            {
                return "{\"type\":\"response\",\"id\":"
                    + AdapterJson.Quote(id)
                    + ",\"ok\":true,\"result\":"
                    + response.ResultJson
                    + "}";
            }
            return "{\"type\":\"response\",\"id\":"
                + AdapterJson.Quote(id)
                + ",\"ok\":false,\"error\":{\"code\":"
                + AdapterJson.Quote(response.ErrorCode)
                + ",\"message\":"
                + AdapterJson.Quote(response.ErrorMessage)
                + "}}";
        }

        private static string ReadFrame(Stream stream)
        {
            var prefix = new byte[4];
            var prefixBytes = ReadExact(stream, prefix, true);
            if (prefixBytes == 0)
            {
                return null;
            }
            var length = prefix[0]
                | (prefix[1] << 8)
                | (prefix[2] << 16)
                | (prefix[3] << 24);
            if (length <= 0 || length > MaximumFrameBytes)
            {
                throw new InvalidDataException(
                    "Adapter frame length is outside the allowed range.");
            }
            var payload = new byte[length];
            ReadExact(stream, payload, false);
            return Utf8.GetString(payload);
        }

        private static int ReadExact(
            Stream stream,
            byte[] buffer,
            bool allowEmpty)
        {
            var offset = 0;
            while (offset < buffer.Length)
            {
                var read = stream.Read(
                    buffer,
                    offset,
                    buffer.Length - offset);
                if (read == 0)
                {
                    if (allowEmpty && offset == 0)
                    {
                        return 0;
                    }
                    throw new EndOfStreamException(
                        "Adapter stream ended within a frame.");
                }
                offset += read;
            }
            return offset;
        }

        private static void WriteDescriptor()
        {
            var descriptorPath = Path.Combine(
                projectRoot,
                DescriptorRelativePath);
            var directory = Path.GetDirectoryName(descriptorPath);
            Directory.CreateDirectory(directory);
            if (endpointKind == "unix-domain-socket")
            {
                Chmod(directory, Convert.ToInt32("700", 8));
            }
            var temporaryPath = descriptorPath
                + "."
                + instanceId
                + ".tmp";
            var descriptor = JsonUtility.ToJson(new SessionDescriptor
            {
                protocolVersion = ProtocolVersion,
                adapterVersion = adapterVersion,
                unityVersion = Application.unityVersion,
                projectHash = projectHash,
                instanceId = instanceId,
                endpointKind = endpointKind,
                endpoint = endpoint,
                token = token,
                processId = Process.GetCurrentProcess().Id
            });
            File.WriteAllText(temporaryPath, descriptor, new UTF8Encoding(false));
            if (endpointKind == "unix-domain-socket")
            {
                Chmod(temporaryPath, Convert.ToInt32("600", 8));
            }
            if (File.Exists(descriptorPath))
            {
                File.Replace(temporaryPath, descriptorPath, null);
            }
            else
            {
                File.Move(temporaryPath, descriptorPath);
            }
        }

        private static void RemoveOwnedDescriptor()
        {
            if (string.IsNullOrWhiteSpace(projectRoot))
            {
                return;
            }
            var descriptorPath = Path.Combine(
                projectRoot,
                DescriptorRelativePath);
            try
            {
                if (!File.Exists(descriptorPath))
                {
                    return;
                }
                var descriptor = JsonUtility.FromJson<SessionDescriptor>(
                    File.ReadAllText(descriptorPath, Utf8));
                if (
                    descriptor != null
                    && string.Equals(
                        descriptor.instanceId,
                        instanceId,
                        StringComparison.Ordinal)
                )
                {
                    File.Delete(descriptorPath);
                }
            }
            catch (Exception)
            {
                // Derived discovery state is best-effort during shutdown.
            }
        }

        private static void RemoveUnixSocket()
        {
            if (
                endpointKind != "unix-domain-socket"
                || string.IsNullOrWhiteSpace(endpoint)
            )
            {
                return;
            }
            try
            {
                if (File.Exists(endpoint))
                {
                    File.Delete(endpoint);
                }
            }
            catch (Exception)
            {
                // The process-lifetime endpoint is already unreachable.
            }
        }

        private static string ResolveAdapterVersion()
        {
            try
            {
                var package = UnityEditor.PackageManager.PackageInfo
                    .FindForAssembly(
                    typeof(AdapterHost).Assembly);
                if (
                    package != null
                    && !string.IsNullOrWhiteSpace(package.version)
                )
                {
                    return package.version;
                }
            }
            catch (Exception)
            {
            }
            return "0.1.0";
        }

        private static string CanonicalProjectIdentity(string path)
        {
            var normalized = path.Normalize(NormalizationForm.FormC);
            if (
                Application.platform == RuntimePlatform.WindowsEditor
                || Application.platform == RuntimePlatform.OSXEditor
            )
            {
                normalized = normalized.ToLowerInvariant();
            }
            return normalized.Normalize(NormalizationForm.FormC);
        }

        private static string RandomToken()
        {
            var bytes = new byte[32];
            using (var generator =
                System.Security.Cryptography.RandomNumberGenerator.Create())
            {
                generator.GetBytes(bytes);
            }
            var builder = new StringBuilder(64);
            foreach (var value in bytes)
            {
                builder.Append(value.ToString("x2"));
            }
            return builder.ToString();
        }

        private static bool ConstantTimeEquals(string left, string right)
        {
            if (left == null || right == null)
            {
                return false;
            }
            var difference = left.Length ^ right.Length;
            var length = Math.Min(left.Length, right.Length);
            for (var index = 0; index < length; index++)
            {
                difference |= left[index] ^ right[index];
            }
            return difference == 0;
        }

        private static uint EffectiveUserId()
        {
            if (Application.platform == RuntimePlatform.WindowsEditor)
            {
                return 0;
            }
            return GetEffectiveUserId();
        }

        private static void Chmod(string path, int mode)
        {
            if (Application.platform == RuntimePlatform.WindowsEditor)
            {
                return;
            }
            if (ChangeMode(path, mode) != 0)
            {
                throw new IOException(
                    "Could not restrict local Adapter path permissions.");
            }
        }

        [DllImport("libc", EntryPoint = "geteuid")]
        private static extern uint GetEffectiveUserId();

        [DllImport("libc", EntryPoint = "chmod", SetLastError = true)]
        private static extern int ChangeMode(string path, int mode);

        [Serializable]
        private sealed class HelloMessage
        {
            public string type;
            public string token;
            public int protocolVersion;
            public string projectHash;
        }

        [Serializable]
        private sealed class RequestMessage
        {
            public string type;
            public string id;
            public string capability;
            public string method;
        }

        [Serializable]
        private sealed class CapabilityMessage
        {
            public string name;
            public int version;
        }

        [Serializable]
        private sealed class WelcomeMessage
        {
            public string type;
            public int protocolVersion;
            public string adapterVersion;
            public string unityVersion;
            public string projectHash;
            public string instanceId;
            public CapabilityMessage[] capabilities;
        }

        [Serializable]
        private sealed class SessionDescriptor
        {
            public int protocolVersion;
            public string adapterVersion;
            public string unityVersion;
            public string projectHash;
            public string instanceId;
            public string endpointKind;
            public string endpoint;
            public string token;
            public int processId;
        }

        private sealed class RequestWork
        {
            internal RequestWork(
                ClientPeer peer,
                RequestMessage request,
                string requestJson)
            {
                Peer = peer;
                Request = request;
                RequestJson = requestJson;
            }

            internal ClientPeer Peer { get; private set; }
            internal RequestMessage Request { get; private set; }
            internal string RequestJson { get; private set; }
        }

        private sealed class ClientPeer : IDisposable
        {
            private readonly Stream stream;
            private readonly object writeLock = new object();
            private volatile bool alive = true;

            internal ClientPeer(Stream stream)
            {
                this.stream = stream;
            }

            internal bool Alive
            {
                get { return alive; }
            }

            internal bool WriteJson(string json)
            {
                if (!alive)
                {
                    return false;
                }
                var payload = Utf8.GetBytes(json);
                if (
                    payload.Length <= 0
                    || payload.Length > MaximumFrameBytes
                )
                {
                    Dispose();
                    return false;
                }
                var prefix = new byte[]
                {
                    (byte)(payload.Length & 0xff),
                    (byte)((payload.Length >> 8) & 0xff),
                    (byte)((payload.Length >> 16) & 0xff),
                    (byte)((payload.Length >> 24) & 0xff)
                };
                lock (writeLock)
                {
                    if (!alive)
                    {
                        return false;
                    }
                    try
                    {
                        stream.Write(prefix, 0, prefix.Length);
                        stream.Write(payload, 0, payload.Length);
                        stream.Flush();
                        return true;
                    }
                    catch (Exception)
                    {
                        Dispose();
                        return false;
                    }
                }
            }

            public void Dispose()
            {
                alive = false;
                try
                {
                    stream.Dispose();
                }
                catch (Exception)
                {
                }
            }
        }
    }
}
