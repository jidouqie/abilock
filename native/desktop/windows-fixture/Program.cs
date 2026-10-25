using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Web.Script.Serialization;
using System.Diagnostics;

// A standalone, unprivileged fixture. It has no production vault, installer,
// account, task, secret, or connection to any provider.
if (!args.SequenceEqual(new[] { "client", "config" })) return 78;
var root = Path.GetFullPath(Environment.GetEnvironmentVariable("ABILOCK_FIXTURE_ROOT")
    ?? Path.Combine(Path.GetTempPath(), "AbilockDesktopBuild-20261014"));
var directory = Path.Combine(root, "net48-results");
if (File.ReadAllText(Path.Combine(root, "abilock-desktop-build.marker")) != "Abilock desktop build 20261014") return 78;
Directory.CreateDirectory(directory);
using var cancellation = new CancellationTokenSource();
var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var port = ((IPEndPoint)listener.LocalEndpoint).Port;
File.WriteAllText(Path.Combine(directory, "fixture-started.json"),
    new JavaScriptSerializer().Serialize(new { processId = Process.GetCurrentProcess().Id, port }));
Console.OutputEncoding = new UTF8Encoding(false);
Console.WriteLine(new JavaScriptSerializer().Serialize(new { type = "configuration-ready", url = $"http://127.0.0.1:{port}" }));
var server = ServeAsync(listener, cancellation.Token);
try { await Console.In.ReadToEndAsync(); }
finally
{
    cancellation.Cancel();
    listener.Stop();
    await server;
    File.WriteAllText(Path.Combine(directory, "fixture-stopped.txt"), "stdin closed; listener stopped");
}
return 0;

static async Task ServeAsync(TcpListener listener, CancellationToken cancellation)
{
    try
    {
        while (!cancellation.IsCancellationRequested)
        {
            using var client = await listener.AcceptTcpClientAsync();
            using var stream = client.GetStream();
            var request = new byte[8192];
            var length = 0;
            while (length < request.Length)
            {
                var count = await stream.ReadAsync(request, length, request.Length - length, cancellation);
                if (count == 0) break;
                length += count;
                if (Encoding.ASCII.GetString(request, 0, length).IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0) break;
            }
            var body = Encoding.UTF8.GetBytes("<!doctype html><html><head><meta charset=\"utf-8\"><title>Abilock test</title></head><body><h1>Abilock synthetic configuration</h1><p>No credentials or real connection data.</p></body></html>");
            var header = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(header, 0, header.Length, cancellation);
            await stream.WriteAsync(body, 0, body.Length, cancellation);
        }
    }
    catch (OperationCanceledException) { }
    catch (SocketException) when (cancellation.IsCancellationRequested) { }
    catch (IOException) when (cancellation.IsCancellationRequested) { }
    catch (ObjectDisposedException) when (cancellation.IsCancellationRequested) { }
}
