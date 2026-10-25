// Fixed Git SSH byte-stream bridge. Upstream credentials never enter this process.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class AbilockGitSsh
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2 || args.Length > 12) return 64;
            string command = args[args.Length - 1];
            if (!Regex.IsMatch(command, "\\Agit-(?:upload|receive)-pack '/?[A-Za-z0-9._/-]+'\\z")) return 64;
            // Git may add the fixed send-environment option. No user SSH options,
            // alternate host, executable or remote command are accepted.
            int at = 0;
            if (args.Length >= 4 && args[0] == "-o" && args[1] == "SendEnv=GIT_PROTOCOL") at = 2;
            if (at + 2 != args.Length || args[at] != "git@abilock.invalid") return 64;
            string filename = Environment.GetEnvironmentVariable("ABILOCK_GIT_BRIDGE_FILE");
            if (String.IsNullOrEmpty(filename) || !Path.IsPathRooted(filename) || new FileInfo(filename).Length > 4096) return 78;
            Dictionary<string, object> config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(filename, new UTF8Encoding(false, true)));
            if (config.Count != 2 || !config.ContainsKey("port") || !config.ContainsKey("capability") ||
                !(config["port"] is int) || !(config["capability"] is string)) return 78;
            int port = (int)config["port"]; string capability = (string)config["capability"];
            if (port < 1 || port > 65535 || !Regex.IsMatch(capability, "\\A[a-f0-9]{64}\\z")) return 78;
            using (TcpClient client = new TcpClient(AddressFamily.InterNetwork))
            {
                client.NoDelay = true;
                Task connect = client.ConnectAsync(IPAddress.Loopback, port);
                if (!connect.Wait(10000)) return 78;
                NetworkStream stream = client.GetStream();
                byte[] hello = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { command = command, capability = capability }) + "\n");
                stream.Write(hello, 0, hello.Length); stream.Flush(); Array.Clear(hello, 0, hello.Length);
                Task input = Task.Run(delegate {
                    try { Console.OpenStandardInput().CopyTo(stream); stream.Flush(); client.Client.Shutdown(SocketShutdown.Send); }
                    catch (IOException) { client.Close(); }
                    catch (SocketException) { client.Close(); }
                });
                stream.CopyTo(Console.OpenStandardOutput());
                // Input can legitimately remain open after remote EOF. Returning
                // closes this operation's socket without waiting on another call.
                return input.IsFaulted ? 78 : 0;
            }
        }
        catch { Console.Error.WriteLine("ABILOCK_GIT_SSH_FAILED"); return 78; }
    }
}
