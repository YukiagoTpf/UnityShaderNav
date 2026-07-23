using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace UnityShaderNav.Adapter
{
    internal static class AdapterJson
    {
        internal static string Quote(string value)
        {
            if (value == null)
            {
                return "null";
            }

            var builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u");
                            builder.Append(
                                ((int)character).ToString(
                                    "x4",
                                    CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }

        internal static string Number(float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                return "null";
            }
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        internal static string Number(int value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        internal static string Number(long value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        internal static string Sha256(byte[] bytes)
        {
            using (var hash = SHA256.Create())
            {
                var digest = hash.ComputeHash(bytes);
                var builder = new StringBuilder(digest.Length * 2);
                foreach (var value in digest)
                {
                    builder.Append(
                        value.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }

        internal static string Sha256(string value)
        {
            return Sha256(new UTF8Encoding(false).GetBytes(value));
        }

        internal static long UnixMilliseconds()
        {
            return (long)(DateTime.UtcNow
                - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc))
                .TotalMilliseconds;
        }
    }
}
