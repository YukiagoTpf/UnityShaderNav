using System;

namespace UnityShaderNav.Adapter
{
    /// <summary>
    /// Main-thread capability boundary hosted by AdapterHost. Implementations
    /// are discovered through UnityEditor.TypeCache.
    /// </summary>
    public interface IAdapterHostCapability
    {
        string Capability { get; }
        int Version { get; }

        AdapterCapabilityResponse Handle(
            string method,
            string requestJson);
    }

    /**
     * Optional main-thread polling boundary for Adapter-owned environment
     * changes that invalidate previously described feature evidence.
     */
    public interface IAdapterHostInvalidationSource
    {
        bool TryGetInvalidation(out string reason);
    }

    public sealed class AdapterCapabilityResponse
    {
        private AdapterCapabilityResponse(
            bool ok,
            string resultJson,
            string errorCode,
            string errorMessage)
        {
            Ok = ok;
            ResultJson = resultJson;
            ErrorCode = errorCode;
            ErrorMessage = errorMessage;
        }

        public bool Ok { get; private set; }
        public string ResultJson { get; private set; }
        public string ErrorCode { get; private set; }
        public string ErrorMessage { get; private set; }

        public static AdapterCapabilityResponse Success(string resultJson)
        {
            if (string.IsNullOrWhiteSpace(resultJson))
            {
                throw new ArgumentException(
                    "A capability success response requires JSON.",
                    "resultJson");
            }

            return new AdapterCapabilityResponse(
                true,
                resultJson,
                null,
                null);
        }

        public static AdapterCapabilityResponse Failure(
            string code,
            string message)
        {
            return new AdapterCapabilityResponse(
                false,
                null,
                string.IsNullOrWhiteSpace(code) ? "internal-error" : code,
                string.IsNullOrWhiteSpace(message)
                    ? "Adapter capability request failed."
                    : message);
        }
    }
}
