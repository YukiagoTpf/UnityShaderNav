using System;

namespace UnityShaderNav.Adapter
{
    /** Event surface for independently versioned capability implementations. */
    public static class AdapterHostEvents
    {
        public static bool Publish(
            string capability,
            string eventName,
            string payloadJson)
        {
            if (
                string.IsNullOrWhiteSpace(capability)
                || string.IsNullOrWhiteSpace(eventName)
            )
            {
                throw new ArgumentException(
                    "Capability and event names must be non-empty.");
            }
            return AdapterHost.PublishCapabilityEvent(
                capability,
                eventName,
                payloadJson);
        }
    }
}
