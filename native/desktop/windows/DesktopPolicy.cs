using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Abilock.Desktop;

internal static class DesktopPolicy
{
    private static readonly Regex ConfigurationAddress = new(@"\Ahttp://127\.0\.0\.1:([1-9][0-9]{0,4})/?\z", RegexOptions.CultureInvariant);
    private const string JsonString = @"""(?:[^""\\\x00-\x1f]|\\(?:[""\\/bfnrt]|u[0-9a-fA-F]{4}))*""";
    private const string Space = @"[ \t\r\n]*";
    // Exactly two JSON string properties. Decoding isolated strings with the
    // Framework serializer avoids type resolution and duplicate-key collapse.
    private static readonly Regex ReadyRecord = new(@"\A" + Space + @"\{" + Space +
        "(?<key1>" + JsonString + ")" + Space + ":" + Space + "(?<value1>" + JsonString + ")" + Space + "," + Space +
        "(?<key2>" + JsonString + ")" + Space + ":" + Space + "(?<value2>" + JsonString + ")" + Space + @"\}" + Space + @"\z",
        RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    internal static Uri? ConfigurationUrl(string? text)
    {
        if (text is null || text.Length > 128) return null;
        var match = ConfigurationAddress.Match(text);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var port) || port is < 1024 or > 65535)
            return null;
        return Uri.TryCreate(text, UriKind.Absolute, out var value) && value.UserInfo.Length == 0 &&
            value.Query.Length == 0 && value.Fragment.Length == 0 && value.AbsolutePath == "/" ? value : null;
    }

    internal static Uri? Readiness(string text)
    {
        if (text.Length is 0 or > 4096) return null;
        try
        {
            var match = ReadyRecord.Match(text);
            if (!match.Success) return null;
            var json = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 };
            var key1 = json.Deserialize<string>(match.Groups["key1"].Value);
            var key2 = json.Deserialize<string>(match.Groups["key2"].Value);
            if (key1 == key2 || !((key1 == "type" && key2 == "url") || (key1 == "url" && key2 == "type"))) return null;
            var value1 = json.Deserialize<string>(match.Groups["value1"].Value);
            var value2 = json.Deserialize<string>(match.Groups["value2"].Value);
            return (key1 == "type" ? value1 : value2) == "configuration-ready"
                ? ConfigurationUrl(key1 == "url" ? value1 : value2) : null;
        }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (RegexMatchTimeoutException) { return null; }
    }

    internal static bool SameOrigin(string? candidate, Uri origin) =>
        Uri.TryCreate(candidate, UriKind.Absolute, out var value) && value.Scheme == origin.Scheme &&
        value.Host == origin.Host && value.Port == origin.Port && value.UserInfo.Length == 0;
}
