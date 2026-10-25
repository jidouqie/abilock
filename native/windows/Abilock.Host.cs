// Build with the Windows .NET Framework 4.x compiler. C# 5 syntax only.
// This executable is not a service. A scheduled task starts one worker per call.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class AbilockHost
{
    private static readonly string ProgramRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Abilock");
    private static readonly string DataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Abilock", "private");
    private static readonly string RuntimeRoot = Path.Combine(ProgramRoot, "runtime");
    private const string TaskFolder = "\\Abilock";
    private const string SystemSid = "S-1-5-18";
    private const string AdminSid = "S-1-5-32-544";
    private const string TrustedInstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    private const int MaximumMetadataBytes = 64 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumMetadataBytes };
    private static Installation installation;
    // Stable public diagnostics. Never derive stage text from an exception,
    // input, path, request body or credential.
    private enum FailureStage {
        Unknown = 0, Installation = 1, Authorization = 2, PipeAcl = 3,
        PipeCreation = 4, SchedulerConnection = 5, TaskLookup = 6,
        TaskStart = 7, PipeConnection = 8, PeerAuthentication = 9,
        ClientExchange = 10, PrivateDirectory = 11, WorkerConnection = 12,
        WorkerPipe = 13, ChildStart = 14, WorkerExchange = 15, UserEntries = 16
    }
    private static FailureStage failureStage;

    private sealed class Installation
    {
        public string version { get; set; }
        public string ownerSid { get; set; }
        public string serviceSid { get; set; }
        public string account { get; set; }
        public int schema { get; set; }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "self-test") return SelfTest();
            if (args.Length == 1 && args[0] == "self-test-child")
            {
                foreach (Environment.SpecialFolder folder in new Environment.SpecialFolder[] {
                    Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.CommonApplicationData })
                {
                    string path = Environment.GetFolderPath(folder);
                    if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) return 23;
                }
                Console.WriteLine("ABILOCK_CHILD_ENVIRONMENT_OK"); Console.Out.Flush();
                using (StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)))
                {
                    if (input.ReadLine() != "ABILOCK_SYNTHETIC_PING") return 24;
                    Console.WriteLine("ABILOCK_SYNTHETIC_ACK"); Console.Out.Flush();
                }
                Thread.Sleep(30000); return 0;
            }
            failureStage = FailureStage.Installation;
            ValidateInstallation();
            failureStage = FailureStage.Authorization;
            if (args.Length == 1 && (args[0] == "validate" || args[0] == "validate-installation"))
            {
                if (args[0] == "validate-installation") RequireAdministrator(); else RequireOwner();
                Console.WriteLine(Json.Serialize(new { ok = true, version = installation.version,
                    ownerSid = installation.ownerSid, serviceSid = installation.serviceSid }));
                return 0;
            }
            if (args.Length == 2 && args[0] == "client" && PublicMode(args[1]))
            { RequireOwner(); return Client(args[1]); }
            if (args.Length == 1 && args[0] == "bootstrap-client")
            { RequireAdministrator(); return Client("bootstrap"); }
            if (args.Length == 1 && args[0] == "register-skills")
            { RequireOwner(); failureStage = FailureStage.UserEntries; RegisterSkills(); Console.WriteLine("ABILOCK_SKILLS_REGISTERED"); return 0; }
            if (args.Length == 3 && args[0] == "worker" && Mode(args[1]) && Nonce(args[2]))
            { RequireWorker(); return Worker(args[1], args[2]); }
            if (args.Length == 2 && args[0] == "check-private")
            { RequireWorker(); failureStage = FailureStage.PrivateDirectory; CheckPrivate(args[1]); Console.Write("OK\n"); return 0; }
            if (args.Length == 2 && args[0] == "check-public")
            { RequireWorker(); failureStage = FailureStage.Installation; CheckPublicPath(args[1]); Console.Write("OK\n"); return 0; }
            if (args.Length == 2 && args[0] == "file-lock")
            { RequireWorker(); failureStage = FailureStage.PrivateDirectory; return FileLock(args[1]); }
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(FormatFailure(failureStage, error));
            return 78;
        }
    }

    private static string FormatFailure(FailureStage stage, Exception error)
    {
        int code = (int)stage;
        if (code < 0 || code > 16) code = 0;
        return "ABILOCK_ISOLATION_FAILED stage=" + code.ToString(System.Globalization.CultureInfo.InvariantCulture) +
            " hresult=" + error.HResult.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static bool PublicMode(string value) { return value == "execute" || value == "config"; }
    private static bool Mode(string value) { return PublicMode(value) || value == "bootstrap"; }
    private static bool Nonce(string value) { return value != null && Regex.IsMatch(value, "\\A[a-f0-9]{64}\\z"); }
    private static string Identity() { return WindowsIdentity.GetCurrent().User.Value; }
    private static void RequireOwner() { if (Identity() != installation.ownerSid) throw new InvalidOperationException(); }
    private static void RequireWorker() { if (Identity() != installation.serviceSid) throw new InvalidOperationException(); }
    private static void RequireAdministrator()
    { if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new InvalidOperationException(); }

    private static void RegisterSkills()
    {
        IntPtr limited = IntPtr.Zero; bool impersonating = false;
        try
        {
            if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            {
                using (WindowsIdentity current = WindowsIdentity.GetCurrent())
                {
                    Native.LinkedToken linked; int returned;
                    if (!Native.GetTokenInformation(current.Token, 19, out linked, IntPtr.Size, out returned))
                        throw new InvalidOperationException();
                    limited = linked.Token;
                }
                if (limited == IntPtr.Zero || !Native.ImpersonateLoggedOnUser(limited)) throw new InvalidOperationException();
                impersonating = true;
            }
            // File creation must use the owner's ordinary token. In particular,
            // an administrator installer must never follow a user-owned junction
            // with its elevated token, even if an earlier path check succeeded.
            if (Identity() != installation.ownerSid || new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException();
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (String.IsNullOrEmpty(profile) || !Regex.IsMatch(profile, "\\A[A-Za-z]:\\\\") || profile.IndexOf(':', 2) >= 0)
                throw new InvalidOperationException();
            CheckAncestors(profile);
            string source = Path.Combine(RuntimeRoot, "skills", "abilock");
            CheckPublicPath(source); CheckPublicPath(Path.Combine(source, "SKILL.md"));
            RequireAbilockSkill(source);
            // Preflight both destinations before changing either host's skill.
            foreach (string tool in new string[] { ".codex", ".claude" })
            {
                string current = Path.Combine(profile, tool);
                if (File.Exists(current)) throw new InvalidOperationException();
                if (Directory.Exists(current)) CheckAncestors(current);
                string backupRoot = Path.Combine(current, "abilock-skill-backups");
                if (File.Exists(backupRoot)) throw new InvalidOperationException();
                if (Directory.Exists(backupRoot)) CheckAncestors(backupRoot);
                current = Path.Combine(current, "skills");
                if (File.Exists(current)) throw new InvalidOperationException();
                if (Directory.Exists(current)) CheckAncestors(current);
                current = Path.Combine(current, "abilock");
                if (File.Exists(current)) throw new InvalidOperationException();
                if (Directory.Exists(current)) { CheckAncestors(current); RequireAbilockSkill(current); }
            }
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            CheckAncestors(programs);
            string shortcut = Path.Combine(programs, "Abilock.lnk");
            CheckOwnerShortcut(shortcut);
            // Check every user entry before changing any of them. Explicit SID
            // registry paths avoid a cached HKCU handle during impersonation.
            using (RegistryKey environment = OpenOwnerEnvironment(false))
                UpdatedUserPath(ReadUserPath(environment), Path.Combine(RuntimeRoot, "bin"));
            foreach (string tool in new string[] { ".codex", ".claude" })
            {
                string toolRoot = Path.Combine(profile, tool);
                if (!Directory.Exists(toolRoot)) Directory.CreateDirectory(toolRoot);
                CheckAncestors(toolRoot);
                string skills = Path.Combine(toolRoot, "skills");
                if (!Directory.Exists(skills)) Directory.CreateDirectory(skills);
                CheckAncestors(skills);
                string target = Path.Combine(skills, "abilock");
                if (Directory.Exists(target) && SameSkillTree(source, target)) continue;
                string nonce = Guid.NewGuid().ToString("N");
                string recovery = Path.Combine(toolRoot, "abilock-skill-backups");
                Directory.CreateDirectory(recovery); CheckAncestors(recovery);
                // Keep staging and backups outside the tool's skill discovery root.
                string stage = Path.Combine(recovery, "stage-" + nonce);
                string backup = Path.Combine(recovery, "previous-" + nonce);
                bool moved = false, complete = false;
                try
                {
                    CopySkill(source, stage);
                    if (Directory.Exists(target)) { CheckAncestors(target); Directory.Move(target, backup); moved = true; }
                    Directory.Move(stage, target); complete = true;
                }
                finally
                {
                    if (!complete && moved && !Directory.Exists(target)) Directory.Move(backup, target);
                    if (Directory.Exists(stage)) { CheckAncestors(stage); Directory.Delete(stage, true); }
                }
                // A previous skill is retained outside the discovery directory.
            }
            RegisterOwnerShortcut(shortcut);
            using (RegistryKey environment = OpenOwnerEnvironment(true))
            {
                string previous = ReadUserPath(environment);
                string next = UpdatedUserPath(previous, Path.Combine(RuntimeRoot, "bin"));
                if (next != previous)
                {
                    RegistryValueKind kind = environment.GetValue("Path", null, RegistryValueOptions.DoNotExpandEnvironmentNames) == null
                        ? RegistryValueKind.ExpandString : environment.GetValueKind("Path");
                    environment.SetValue("Path", next, kind);
                }
            }
            IntPtr ignored;
            Native.SendMessageTimeout(new IntPtr(0xffff), 0x1a, IntPtr.Zero, "Environment", 2, 2000, out ignored);
        }
        finally
        {
            if (impersonating && !Native.RevertToSelf()) Environment.FailFast("ABILOCK_IDENTITY_RESTORE_FAILED");
            if (limited != IntPtr.Zero) Native.CloseHandle(limited);
        }
    }

    private static RegistryKey OpenOwnerEnvironment(bool writable)
    {
        using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Default))
        using (RegistryKey owner = users.OpenSubKey(Identity(), writable))
        {
            if (owner == null) throw new InvalidOperationException();
            RegistryKey environment = owner.OpenSubKey("Environment", writable);
            if (environment == null && writable) environment = owner.CreateSubKey("Environment");
            return environment;
        }
    }

    private static string ReadUserPath(RegistryKey environment)
    {
        if (environment == null) return null;
        object value = environment.GetValue("Path", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        if (value == null) return null;
        RegistryValueKind kind = environment.GetValueKind("Path");
        if (!(value is string) || (kind != RegistryValueKind.String && kind != RegistryValueKind.ExpandString))
            throw new InvalidOperationException();
        return (string)value;
    }

    private static string UpdatedUserPath(string previous, string bin)
    {
        if (previous != null && (previous.Length > 32700 || previous.IndexOf('\0') >= 0)) throw new InvalidOperationException();
        foreach (string entry in (previous ?? "").Split(';'))
            if (String.Equals(entry.Trim().Trim('"').TrimEnd('\\'), bin.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return previous;
        string result = String.IsNullOrEmpty(previous) ? bin : previous + ";" + bin;
        if (result.Length > 32700) throw new InvalidOperationException();
        return result;
    }

    private static bool CheckOwnerShortcut(string path)
    {
        if (Directory.Exists(path)) throw new InvalidOperationException();
        if (!File.Exists(path)) return false;
        CheckAncestors(path);
        if (new FileInfo(path).Length > 65536) throw new InvalidOperationException();
        object shell = null, link = null;
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            link = ((dynamic)shell).CreateShortcut(path);
            if (!SamePath((string)((dynamic)link).TargetPath, Path.Combine(ProgramRoot, "desktop", "Abilock.exe")) ||
                !String.IsNullOrEmpty((string)((dynamic)link).Arguments) ||
                !SamePath((string)((dynamic)link).WorkingDirectory, Path.Combine(ProgramRoot, "desktop")))
                throw new InvalidOperationException();
            return true;
        }
        finally
        {
            foreach (object value in new object[] { link, shell })
                if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
    }

    private static void RegisterOwnerShortcut(string path)
    {
        if (CheckOwnerShortcut(path)) return;
        string temporary = Path.Combine(Path.GetDirectoryName(path), ".abilock-" + Guid.NewGuid().ToString("N") + ".lnk");
        object shell = null, link = null;
        try
        {
            CheckAncestors(Path.GetDirectoryName(path));
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
            link = ((dynamic)shell).CreateShortcut(temporary);
            ((dynamic)link).TargetPath = Path.Combine(ProgramRoot, "desktop", "Abilock.exe");
            ((dynamic)link).WorkingDirectory = Path.Combine(ProgramRoot, "desktop");
            ((dynamic)link).Description = "Abilock";
            ((dynamic)link).Save();
            CheckOwnerShortcut(temporary);
            // Move never replaces a name inserted after the preflight.
            File.Move(temporary, path);
        }
        finally
        {
            foreach (object value in new object[] { link, shell })
                if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void CopySkill(string source, string target)
    {
        CheckPublicPath(source);
        if (Directory.Exists(source))
        {
            Directory.CreateDirectory(target); CheckAncestors(target);
            foreach (string entry in Directory.GetFileSystemEntries(source)) CopySkill(entry, Path.Combine(target, Path.GetFileName(entry)));
        }
        else File.Copy(source, target, false);
    }

    private static void RequireAbilockSkill(string directory)
    {
        string filename = Path.Combine(directory, "SKILL.md"); CheckAncestors(filename);
        if (new FileInfo(filename).Length > 65536) throw new InvalidOperationException();
        string text = File.ReadAllText(filename, new UTF8Encoding(false, true));
        Match front = Regex.Match(text, "\\A---\\r?\\n(?<header>[\\s\\S]*?)\\r?\\n---(?:\\r?\\n|\\z)");
        if (!front.Success || Regex.Matches(front.Groups["header"].Value, "(?m)^name:[ \\t]*(?:abilock|\"abilock\"|'abilock')[ \\t]*\\r?$").Count != 1)
            throw new InvalidOperationException();
    }

    private static bool SameSkillTree(string source, string target)
    {
        CheckAncestors(source); CheckAncestors(target);
        string[] left = Directory.GetFileSystemEntries(source).OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();
        string[] right = Directory.GetFileSystemEntries(target).OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();
        if (left.Length != right.Length) return false;
        for (int i = 0; i < left.Length; i++)
        {
            if (Path.GetFileName(left[i]) != Path.GetFileName(right[i])) return false;
            CheckAncestors(right[i]); CheckPublicPath(left[i]);
            bool directory = Directory.Exists(left[i]); if (directory != Directory.Exists(right[i])) return false;
            if (directory) { if (!SameSkillTree(left[i], right[i])) return false; }
            else
            {
                if (new FileInfo(left[i]).Length != new FileInfo(right[i]).Length) return false;
                using (SHA256 hash = SHA256.Create())
                using (FileStream a = File.OpenRead(left[i]))
                using (FileStream b = File.OpenRead(right[i]))
                    if (!hash.ComputeHash(a).SequenceEqual(hash.ComputeHash(b))) return false;
            }
        }
        return true;
    }
    private static bool SamePath(string a, string b) { return String.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }

    private static void ValidateInstallation()
    {
        if (!SamePath(Process.GetCurrentProcess().MainModule.FileName, Path.Combine(ProgramRoot, "Abilock.Host.exe")))
            throw new InvalidOperationException();
        CheckInstallationParents(ProgramRoot);
        CheckInstallationParents(DataRoot);
        CheckPublic(ProgramRoot);
        CheckPublic(Path.Combine(ProgramRoot, "Abilock.Host.exe"));
        string metadata = Path.Combine(ProgramRoot, "windows-installation.json");
        CheckPublic(metadata);
        if (new FileInfo(metadata).Length > MaximumMetadataBytes) throw new InvalidOperationException();
        installation = Json.Deserialize<Installation>(File.ReadAllText(metadata, Encoding.UTF8));
        if (installation == null || installation.schema != 1 || installation.account != "_abilock" ||
            !Regex.IsMatch(installation.version ?? "", "\\A[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\\z") ||
            !Regex.IsMatch(installation.ownerSid ?? "", "\\AS-1-5-21-[0-9-]+\\z") ||
            !Regex.IsMatch(installation.serviceSid ?? "", "\\AS-1-5-21-[0-9-]+\\z") ||
            installation.ownerSid == installation.serviceSid)
            throw new InvalidOperationException();
        CheckPublic(RuntimeRoot);
        CheckPublic(Path.Combine(ProgramRoot, "node.exe"));
        CheckPublic(Path.Combine(RuntimeRoot, "dist", "src", "windows-worker.js"));
    }

    private static void CheckAncestors(string target)
    {
        string current = Path.GetFullPath(target);
        while (!String.IsNullOrEmpty(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException();
            string parent = Path.GetDirectoryName(current);
            if (String.IsNullOrEmpty(parent) || SamePath(parent, current)) break;
            current = parent;
        }
    }

    private static FileSystemSecurity Security(string target)
    {
        return Directory.Exists(target)
            ? (FileSystemSecurity)Directory.GetAccessControl(target, AccessControlSections.Owner | AccessControlSections.Access)
            : (FileSystemSecurity)File.GetAccessControl(target, AccessControlSections.Owner | AccessControlSections.Access);
    }

    private static bool SafeParentAcl(FileSystemSecurity security)
    {
        if (!SafeDacl(security)) return false;
        string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
        if (owner != AdminSid && owner != SystemSid && owner != TrustedInstallerSid) return false;
        FileSystemRights replacement = FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.Delete |
            FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership | (FileSystemRights)0x50000000;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            // ProgramData legitimately permits creating new folders. Only an
            // ACE that can replace an existing protected subtree is rejected.
            if (rule.AccessControlType != AccessControlType.Allow ||
                (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0 || (rule.FileSystemRights & replacement) == 0) continue;
            string sid = rule.IdentityReference.Value;
            if (sid != AdminSid && sid != SystemSid && sid != TrustedInstallerSid) return false;
        }
        return true;
    }

    private static bool SafeDacl(ObjectSecurity security)
    {
        try
        {
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
            if (descriptor.DiscretionaryAcl == null) return false;
            foreach (GenericAce entry in descriptor.DiscretionaryAcl)
            {
                CommonAce ace = entry as CommonAce;
                if (ace == null || ace.IsCallback || (ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied)) return false;
            }
            return true;
        }
        catch { return false; }
    }

    private static void CheckInstallationParents(string target)
    {
        for (string current = Path.GetDirectoryName(target); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            CheckAncestors(current);
            if (!SafeParentAcl(Security(current))) throw new InvalidOperationException();
        }
    }

    private static void CheckPublic(string target)
    {
        CheckAncestors(target);
        FileSystemSecurity security = Security(target);
        if (!SafeDacl(security)) throw new InvalidOperationException();
        string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
        if (owner != AdminSid && owner != SystemSid) throw new InvalidOperationException();
        FileSystemRights writes = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete |
            FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership | FileSystemRights.DeleteSubdirectoriesAndFiles | (FileSystemRights)0x50000000;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || (rule.FileSystemRights & writes) == 0) continue;
            string sid = rule.IdentityReference.Value;
            if (sid != AdminSid && sid != SystemSid) throw new InvalidOperationException();
        }
        if (!Directory.Exists(target)) CheckSingleLink(target);
    }

    private static string PrivatePath(string target)
    {
        if (String.IsNullOrEmpty(target) || target.IndexOf(':', 2) >= 0) throw new InvalidOperationException();
        string full = Path.GetFullPath(target);
        if (!SamePath(full, DataRoot) && !full.StartsWith(DataRoot + "\\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException();
        return full;
    }

    private static void CheckPublicPath(string target)
    {
        if (String.IsNullOrEmpty(target) || target.IndexOf(':', 2) >= 0) throw new InvalidOperationException();
        string full = Path.GetFullPath(target);
        if (!SamePath(full, ProgramRoot) && !full.StartsWith(ProgramRoot + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        for (string current = full; ; current = Path.GetDirectoryName(current))
        { CheckPublic(current); if (SamePath(current, ProgramRoot)) break; }
    }

    private static void CheckPrivate(string target, bool checkLink = true)
    {
        string full = PrivatePath(target);
        CheckAncestors(full);
        string current = full;
        while (true)
        {
            FileSystemSecurity security = Security(current);
            if (!SafeDacl(security)) throw new InvalidOperationException();
            string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
            if (owner != AdminSid && owner != SystemSid && owner != installation.serviceSid) throw new InvalidOperationException();
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                string sid = rule.IdentityReference.Value;
                if (sid != AdminSid && sid != SystemSid && sid != installation.serviceSid) throw new InvalidOperationException();
            }
            if (SamePath(current, DataRoot)) break;
            current = Path.GetDirectoryName(current);
        }
        if (checkLink && !Directory.Exists(full)) CheckSingleLink(full);
    }

    private static void CheckSingleLink(string target)
    {
        using (SafeFileHandle handle = Native.CreateFile(target, 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
        {
            Native.ByHandleFileInformation info;
            if (handle.IsInvalid || !Native.GetFileInformationByHandle(handle, out info) || info.NumberOfLinks != 1 ||
                (info.FileAttributes & 0x400) != 0) throw new InvalidOperationException();
        }
    }

    private static int FileLock(string target)
    {
        string full = PrivatePath(target);
        if (!full.EndsWith(".lock", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        CheckPrivate(Path.GetDirectoryName(full));
        FileStream held;
        try { held = new FileStream(full, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException error)
        {
            int code = Marshal.GetHRForException(error) & 0xffff;
            if (code == 32 || code == 33) return 75;
            throw;
        }
        using (held)
        {
            CheckPrivate(full, false);
            Native.ByHandleFileInformation info;
            if (!Native.GetFileInformationByHandle(held.SafeFileHandle, out info) || info.NumberOfLinks != 1 ||
                (info.FileAttributes & 0x400) != 0) throw new InvalidOperationException();
            Console.Write("LOCKED\n"); Console.Out.Flush();
            using (Stream input = Console.OpenStandardInput()) { byte[] bytes = new byte[64]; while (input.Read(bytes, 0, bytes.Length) != 0) { } }
        }
        return 0;
    }

    private static string RandomNonce()
    { byte[] bytes = new byte[32]; using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }

    private static PipeSecurity BuildPipeSecurity(string mode, string ownerSid, string serviceSid)
    {
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        SecurityIdentifier owner = new SecurityIdentifier(mode == "bootstrap" ? AdminSid : ownerSid);
        security.SetOwner(owner);
        // The string overload treats its input as an account name. Supply SID
        // objects so local and synthetic SIDs never go through name resolution.
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(serviceSid), PipeAccessRights.ReadWrite | PipeAccessRights.ReadPermissions, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(SystemSid), PipeAccessRights.FullControl, AccessControlType.Allow));
        return security;
    }

    private static int Client(string mode)
    {
        string nonce = RandomNonce();
        failureStage = FailureStage.PipeAcl;
        PipeSecurity security = BuildPipeSecurity(mode, installation.ownerSid, installation.serviceSid);
        failureStage = FailureStage.PipeCreation;
        using (NamedPipeServerStream pipe = new NamedPipeServerStream("Abilock-" + nonce, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security))
        {
            object scheduler = null, folder = null, task = null, running = null;
            try
            {
                failureStage = FailureStage.SchedulerConnection;
                Type schedulerType = Type.GetTypeFromProgID("Schedule.Service", true);
                scheduler = Activator.CreateInstance(schedulerType);
                dynamic service = scheduler;
                service.Connect();
                failureStage = FailureStage.TaskLookup;
                folder = service.GetFolder(TaskFolder);
                task = ((dynamic)folder).GetTask(mode == "config" ? "Config" : mode == "bootstrap" ? "Bootstrap" : "Execute");
                failureStage = FailureStage.TaskStart;
                running = ((dynamic)task).Run(nonce);
            }
            finally
            {
                foreach (object value in new object[] { running, task, folder, scheduler })
                    if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
            }
            failureStage = FailureStage.PipeConnection;
            IAsyncResult waiting = pipe.BeginWaitForConnection(null, null);
            if (!waiting.AsyncWaitHandle.WaitOne(30000)) throw new TimeoutException();
            pipe.EndWaitForConnection(waiting);
            // No input (including the installer password) is forwarded before
            // the kernel confirms the peer SID. The one-byte hello establishes
            // the token of the last writer for ImpersonateNamedPipeClient.
            failureStage = FailureStage.PeerAuthentication;
            AuthenticatePipePeer(pipe, installation.serviceSid);
            failureStage = FailureStage.ClientExchange;
            Task input = Task.Run(delegate {
                bool sent = false;
                try
                {
                    if (mode == "bootstrap")
                    {
                        byte[] bytes = new byte[8193]; int length = 0, read;
                        Stream source = Console.OpenStandardInput();
                        while ((read = source.Read(bytes, length, bytes.Length - length)) > 0)
                        { length += read; if (length > 8192) throw new InvalidOperationException(); }
                        pipe.Write(bytes, 0, length); pipe.WriteByte(10); pipe.Flush(); Array.Clear(bytes, 0, bytes.Length);
                        sent = true;
                    }
                    else { Console.OpenStandardInput().CopyTo(pipe); pipe.Flush(); }
                }
                finally { if (mode != "bootstrap" || !sent) pipe.Dispose(); }
            });
            try { pipe.CopyTo(Console.OpenStandardOutput()); }
            catch (ObjectDisposedException) { if (!input.IsCompleted) throw; }
            catch (IOException) { if (!input.IsCompleted) throw; }
            return 0;
        }
    }

    private static void AuthenticatePipePeer(NamedPipeServerStream pipe, string expectedSid)
    {
        Task<int> hello = Task.Run(delegate { return pipe.ReadByte(); });
        if (!hello.Wait(30000) || hello.Result != 0 || PipeClientSid(pipe) != expectedSid)
            throw new InvalidOperationException();
    }

    private static string PipeClientSid(NamedPipeServerStream pipe)
    {
        if (!Native.ImpersonateNamedPipeClient(pipe.SafePipeHandle)) throw new InvalidOperationException();
        IntPtr token = IntPtr.Zero;
        try
        {
            // The worker grants Identification, not Impersonation. Querying
            // its identity does not grant access to any worker-owned resource.
            if (!Native.OpenThreadToken(Native.GetCurrentThread(), 8, true, out token)) throw new InvalidOperationException();
            using (WindowsIdentity identity = new WindowsIdentity(token))
            {
                if (identity.ImpersonationLevel != TokenImpersonationLevel.Identification) throw new InvalidOperationException();
                return identity.User.Value;
            }
        }
        finally { if (token != IntPtr.Zero) Native.CloseHandle(token); if (!Native.RevertToSelf()) Environment.FailFast("ABILOCK_IDENTITY_RESTORE_FAILED"); }
    }

    private static int Worker(string mode, string nonce)
    {
        failureStage = FailureStage.PrivateDirectory;
        CheckPrivate(DataRoot);
        // Identification is essential: the caller must never impersonate this account.
        failureStage = FailureStage.WorkerConnection;
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", "Abilock-" + nonce, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
        {
            pipe.Connect(30000);
            // Checking the pipe object's owner works across SIDs without debug or
            // impersonation privileges. No caller-supplied owner claim is trusted.
            failureStage = FailureStage.WorkerPipe;
            PipeSecurity pipeSecurity = pipe.GetAccessControl();
            if (!SafeDacl(pipeSecurity)) throw new InvalidOperationException();
            string pipeOwner = pipeSecurity.GetOwner(typeof(SecurityIdentifier)).Value;
            if (mode == "bootstrap" ? (pipeOwner != AdminSid && pipeOwner != SystemSid) : pipeOwner != installation.ownerSid)
                throw new InvalidOperationException();
            foreach (PipeAccessRule rule in pipeSecurity.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Value != (mode == "bootstrap" ? AdminSid : installation.ownerSid) &&
                    rule.IdentityReference.Value != installation.serviceSid && rule.IdentityReference.Value != SystemSid)
                    throw new InvalidOperationException();
            pipe.WriteByte(0); pipe.Flush();
            failureStage = FailureStage.ChildStart;
            using (ChildProcess child = ChildProcess.Start(mode))
            {
                failureStage = FailureStage.WorkerExchange;
                Task input = Task.Run(delegate {
                    try
                    {
                        if (mode == "bootstrap")
                        {
                            int size = 0, next;
                            while ((next = pipe.ReadByte()) != 10)
                            { if (next < 0 || ++size > 8192) throw new InvalidOperationException(); child.Input.WriteByte((byte)next); }
                            child.Input.Flush();
                        }
                        else CopyInputWithFlush(pipe, child.Input);
                    }
                    catch (IOException) { }
                    finally { child.Input.Dispose(); }
                });
                Task output = Task.Run(delegate { try { child.Output.CopyTo(pipe); pipe.Flush(); } catch (IOException) { } });
                Task discard = Task.Run(delegate { try { child.Error.CopyTo(Stream.Null); } catch (IOException) { } });
                Task exited = Task.Run(delegate { child.Wait(12 * 60 * 60 * 1000); });
                int winner = mode == "bootstrap" ? Task.WaitAny(new Task[] { output, exited }) + 1 : Task.WaitAny(new Task[] { input, output, exited });
                if (winner != 2 && !child.Wait(6500)) child.Terminate();
                if (!child.Wait(6500)) throw new TimeoutException();
                // Drain the final response before closing the pipe; never truncate at process exit.
                if (!output.Wait(6500)) throw new TimeoutException();
                discard.Wait(6500);
                return child.ExitCode;
            }
        }
    }

    private static void CopyInputWithFlush(Stream input, Stream output)
    {
        byte[] buffer = new byte[65536]; int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
        {
            output.Write(buffer, 0, count);
            // The child input is a buffered FileStream. Forward every chunk
            // now: callers keep stdin open while waiting for a response.
            output.Flush();
        }
    }

    private sealed class ChildProcess : IDisposable
    {
        private IntPtr process, job;
        public Stream Input, Output, Error;
        public int ExitCode { get { uint code; if (!Native.GetExitCodeProcess(process, out code)) return 78; return (int)code; } }
        public bool Wait(int milliseconds) { return Native.WaitForSingleObject(process, (uint)milliseconds) == 0; }
        public void Terminate() { if (job != IntPtr.Zero) Native.TerminateJobObject(job, 78); }
        public void CloseJob() { if (job != IntPtr.Zero) { Native.CloseHandle(job); job = IntPtr.Zero; } }
        public void Dispose()
        {
            CloseJob();
            if (process != IntPtr.Zero) { Native.CloseHandle(process); process = IntPtr.Zero; }
            if (Input != null) Input.Dispose(); if (Output != null) Output.Dispose(); if (Error != null) Error.Dispose();
        }
        public static ChildProcess Start(string mode, bool fixture = false, string fixtureProfile = null)
        {
            if (fixture != !String.IsNullOrEmpty(fixtureProfile)) throw new InvalidOperationException();
            ChildProcess child = new ChildProcess();
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero,
                errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero, environment = IntPtr.Zero, thread = IntPtr.Zero;
            try
            {
                Native.SecurityAttributes attributes = new Native.SecurityAttributes { Length = Marshal.SizeOf(typeof(Native.SecurityAttributes)), InheritHandle = true };
                if (!Native.CreatePipe(out inputRead, out inputWrite, ref attributes, 65536) ||
                    !Native.CreatePipe(out outputRead, out outputWrite, ref attributes, 65536) ||
                    !Native.CreatePipe(out errorRead, out errorWrite, ref attributes, 65536) ||
                    !Native.SetHandleInformation(inputWrite, 1, 0) || !Native.SetHandleInformation(outputRead, 1, 0) ||
                    !Native.SetHandleInformation(errorRead, 1, 0)) throw new Win32Exception();
                child.job = Native.CreateJobObject(IntPtr.Zero, null);
                Native.JobExtendedLimit limit = new Native.JobExtendedLimit(); limit.BasicLimitInformation.LimitFlags = 0x2000;
                if (child.job == IntPtr.Zero || !Native.SetInformationJobObject(child.job, 9, ref limit, (uint)Marshal.SizeOf(limit))) throw new Win32Exception();
                string system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
                string profile = fixture ? Path.GetFullPath(fixtureProfile) : DataRoot;
                SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
                    { "SystemRoot", system }, { "WINDIR", system }, { "PATH", Path.Combine(system, "System32") },
                    { "SystemDrive", Path.GetPathRoot(system).TrimEnd(Path.DirectorySeparatorChar) },
                    { "ProgramFiles", Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) },
                    { "ProgramData", Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData) },
                    { "HOME", profile }, { "USERPROFILE", profile }, { "TEMP", Path.Combine(profile, "tmp") }, { "TMP", Path.Combine(profile, "tmp") }
                };
                string block = String.Join("\0", values.Select(pair => pair.Key + "=" + pair.Value).ToArray()) + "\0\0";
                environment = Marshal.StringToHGlobalUni(block);
                Native.StartupInfo startup = new Native.StartupInfo { Size = Marshal.SizeOf(typeof(Native.StartupInfo)), Flags = 0x100,
                    StandardInput = inputRead, StandardOutput = outputWrite, StandardError = errorWrite };
                Native.ProcessInformation created;
                string node = fixture ? Process.GetCurrentProcess().MainModule.FileName : Path.Combine(ProgramRoot, "node.exe");
                string entry = Path.Combine(RuntimeRoot, "dist", "src", "windows-worker.js");
                StringBuilder command = new StringBuilder(fixture ? "\"" + node + "\" self-test-child" : "\"" + node + "\" \"" + entry + "\" " + mode);
                if (!Native.CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x00000404 | 0x08000000,
                    environment, fixture ? Path.GetDirectoryName(node) : RuntimeRoot, ref startup, out created)) throw new Win32Exception();
                child.process = created.Process; thread = created.Thread;
                // The child cannot execute any instruction before containment is attached.
                if (!Native.AssignProcessToJobObject(child.job, child.process)) { Native.TerminateProcess(child.process, 78); throw new Win32Exception(); }
                if (Native.ResumeThread(thread) == 0xffffffff) throw new Win32Exception();
                child.Input = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 65536, false); inputWrite = IntPtr.Zero;
                child.Output = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 65536, false); outputRead = IntPtr.Zero;
                child.Error = new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read, 65536, false); errorRead = IntPtr.Zero;
                return child;
            }
            catch { child.Dispose(); throw; }
            finally
            {
                foreach (IntPtr value in new IntPtr[] { inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite, thread })
                    if (value != IntPtr.Zero) Native.CloseHandle(value);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
        }
    }

    private static int SelfTest()
    {
        Exception diagnostic = new InvalidOperationException("FAKE_SECRET_MUST_NOT_APPEAR");
        foreach (int value in new int[] { -1, 0, 3, 16, 17, Int32.MaxValue })
        {
            string text = FormatFailure((FailureStage)value, diagnostic);
            int expected = value < 0 || value > 16 ? 0 : value;
            if (text != "ABILOCK_ISOLATION_FAILED stage=" + expected + " hresult=" + diagnostic.HResult || text.Contains(diagnostic.Message)) return 22;
        }
        if (!Nonce(new string('a', 64)) || Nonce("x") || Nonce(new string('a', 64) + "\n") ||
            !PublicMode("execute") || PublicMode("bootstrap") || PublicMode("execute --eval") || !Mode("bootstrap")) return 1;
        DirectorySecurity validParent = new DirectorySecurity();
        validParent.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;0x4;;;AU)(A;OICIIO;FA;;;CO)");
        if (!SafeParentAcl(validParent)) return 8;
        DirectorySecurity unsafeParent = new DirectorySecurity();
        unsafeParent.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;;FA;;;BA)(A;;0x40;;;AU)");
        if (SafeParentAcl(unsafeParent)) return 9;
        foreach (string rights in new string[] { "GW", "GA" })
        {
            DirectorySecurity generic = new DirectorySecurity();
            generic.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;;FA;;;BA)(A;;" + rights + ";;;AU)");
            if (SafeParentAcl(generic)) return 10;
        }
        DirectorySecurity unrestricted = new DirectorySecurity();
        unrestricted.SetSecurityDescriptorSddlForm("O:BAG:BAD:NO_ACCESS_CONTROL");
        if (SafeDacl(unrestricted)) return 11;
        string skillFixture = Path.Combine(Path.GetTempPath(), "abilock-skill-policy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(skillFixture);
        try
        {
            string skillFile = Path.Combine(skillFixture, "SKILL.md");
            File.WriteAllText(skillFile, "---\nname: abilock\n---\nSynthetic skill\n", new UTF8Encoding(false));
            RequireAbilockSkill(skillFixture);
            File.WriteAllText(skillFile, "---\nname: unrelated-skill\n---\nKeep this skill\n", new UTF8Encoding(false));
            bool refused = false; try { RequireAbilockSkill(skillFixture); } catch (InvalidOperationException) { refused = true; }
            if (!refused) return 12;
        }
        finally { Directory.Delete(skillFixture, true); }
        string binFixture = @"C:\Program Files\Abilock\runtime\bin";
        if (UpdatedUserPath(null, binFixture) != binFixture ||
            UpdatedUserPath(@"C:\Tools", binFixture) != @"C:\Tools;" + binFixture ||
            UpdatedUserPath(@"C:\Tools;" + binFixture.ToUpperInvariant() + @"\", binFixture) != @"C:\Tools;" + binFixture.ToUpperInvariant() + @"\" ||
            UpdatedUserPath("\"" + binFixture + "\"", binFixture) != "\"" + binFixture + "\"") return 13;
        bool pathRefused = false;
        try { UpdatedUserPath(new string('a', 32700), binFixture); } catch (InvalidOperationException) { pathRefused = true; }
        if (!pathRefused) return 14;
        string entryFixture = Path.Combine(Path.GetTempPath(), "abilock-owner-entry-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(entryFixture);
        try
        {
            string shortcut = Path.Combine(entryFixture, "Abilock.lnk");
            RegisterOwnerShortcut(shortcut);
            byte[] original = File.ReadAllBytes(shortcut);
            RegisterOwnerShortcut(shortcut);
            if (!CheckOwnerShortcut(shortcut) || !original.SequenceEqual(File.ReadAllBytes(shortcut))) return 15;
            File.Delete(shortcut);
            byte[] unknown = Encoding.UTF8.GetBytes("Keep this unrelated shortcut");
            File.WriteAllBytes(shortcut, unknown);
            bool refused = false; try { RegisterOwnerShortcut(shortcut); } catch (Exception) { refused = true; }
            if (!refused || !unknown.SequenceEqual(File.ReadAllBytes(shortcut))) return 16;
            File.Delete(shortcut); Directory.CreateDirectory(shortcut);
            refused = false; try { RegisterOwnerShortcut(shortcut); } catch (InvalidOperationException) { refused = true; }
            if (!refused || !Directory.Exists(shortcut)) return 17;
        }
        finally { Directory.Delete(entryFixture, true); }
        bool administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        foreach (string mode in new string[] { "execute", "bootstrap" })
        {
            string owner = mode == "bootstrap" ? AdminSid : Identity();
            string service = "S-1-5-21-1-2-3-9999";
            PipeSecurity security = BuildPipeSecurity(mode, Identity(), service);
            if (!security.AreAccessRulesProtected || security.GetOwner(typeof(SecurityIdentifier)).Value != owner) return 18;
            AuthorizationRuleCollection rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));
            if (rules.Count != 3) return 19;
            foreach (PipeAccessRule rule in rules)
            {
                string sid = rule.IdentityReference.Value;
                PipeAccessRights expected = sid == service ? PipeAccessRights.ReadWrite | PipeAccessRights.ReadPermissions : PipeAccessRights.FullControl;
                // Allow rules include Synchronize automatically in the managed API.
                if ((sid != owner && sid != service && sid != SystemSid) || rule.AccessControlType != AccessControlType.Allow ||
                    (rule.PipeAccessRights & ~PipeAccessRights.Synchronize) != (expected & ~PipeAccessRights.Synchronize)) return 20;
            }
            // Creating a BA-owned bootstrap pipe requires the administrator
            // token used by the installer. Ordinary self-tests still exercise
            // the same ACL builder and create the ordinary execution pipe.
            if (mode == "bootstrap" && !administrator) continue;
            using (NamedPipeServerStream pipe = new NamedPipeServerStream("Abilock-test-acl-" + RandomNonce(), PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security))
            {
                PipeSecurity actual = pipe.GetAccessControl();
                if (!actual.AreAccessRulesProtected || actual.GetOwner(typeof(SecurityIdentifier)).Value != owner ||
                    actual.GetAccessRules(true, false, typeof(SecurityIdentifier)).Count != 3) return 21;
            }
        }
        // Synthetic same-user pipe attacker. The peer writes the expected hello
        // but is not the dedicated SID, and must receive zero password bytes.
        string before = Identity();
        foreach (bool matching in new bool[] { true, false })
        {
            string name = "Abilock-test-" + RandomNonce(); int received = -2; bool authenticated = false;
            using (NamedPipeServerStream server = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
            {
                Task peerTask = Task.Run(delegate {
                    using (NamedPipeClientStream peer = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                        PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
                    { peer.Connect(10000); peer.WriteByte(0); peer.Flush(); received = peer.ReadByte(); }
                });
                IAsyncResult waiting = server.BeginWaitForConnection(null, null);
                if (!waiting.AsyncWaitHandle.WaitOne(10000)) return 2;
                server.EndWaitForConnection(waiting);
                try { AuthenticatePipePeer(server, matching ? before : "S-1-5-21-1-2-3-9999"); authenticated = true; }
                catch (InvalidOperationException) { }
                if (authenticated != matching || Identity() != before) return 3;
                if (authenticated) { server.WriteByte(42); server.Flush(); }
                server.Dispose();
                if (!peerTask.Wait(10000) || received != (matching ? 42 : -1)) return 4;
            }
        }
        // This child only sleeps in this same public test executable. It must
        // be killed by closing its job, without a process-name search or kill.
        string fixtureProfile = Path.Combine(Path.GetTempPath(), "abilock-host-profile-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(fixtureProfile);
        Directory.CreateDirectory(Path.Combine(fixtureProfile, "tmp"));
        try
        {
            using (ChildProcess child = ChildProcess.Start("execute", true, fixtureProfile))
            {
                try
                {
                    using (StreamReader reader = new StreamReader(child.Output, Encoding.UTF8, true, 1024, true))
                    {
                        Task<string> ready = reader.ReadLineAsync();
                        if (!ready.Wait(10000) || ready.Result != "ABILOCK_CHILD_ENVIRONMENT_OK") return 23;
                        if (!SelfTestOpenInput(child, reader)) return 24;
                    }
                    if (child.Wait(100)) return 6;
                    child.CloseJob();
                    if (!child.Wait(5000)) return 7;
                }
                finally
                {
                    child.CloseJob();
                    if (!child.Wait(5000)) throw new TimeoutException();
                }
            }
        }
        finally { CheckAncestors(fixtureProfile); Directory.Delete(fixtureProfile, true); }
        Console.WriteLine("ABILOCK_HOST_SELF_TEST_OK"); return 0;
    }

    private static bool SelfTestOpenInput(ChildProcess child, StreamReader reader)
    {
        string name = "Abilock-test-input-" + RandomNonce();
        using (NamedPipeServerStream source = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (NamedPipeClientStream sender = new NamedPipeClientStream(".", name, PipeDirection.Out, PipeOptions.Asynchronous))
        {
            IAsyncResult waiting = source.BeginWaitForConnection(null, null);
            sender.Connect(5000);
            if (!waiting.AsyncWaitHandle.WaitOne(5000)) throw new TimeoutException();
            source.EndWaitForConnection(waiting);
            Task pump = Task.Run(delegate {
                try { CopyInputWithFlush(source, child.Input); }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                finally { try { child.Input.Dispose(); } catch (IOException) { } }
            });
            try
            {
                byte[] frame = Encoding.ASCII.GetBytes("ABILOCK_SYNTHETIC_PING\n");
                sender.Write(frame, 0, frame.Length); sender.Flush();
                Task<string> response = reader.ReadLineAsync();
                // The sender is deliberately still open. EOF-triggered flushing
                // cannot satisfy this assertion, and no input is echoed.
                return response.Wait(5000) && response.Result == "ABILOCK_SYNTHETIC_ACK";
            }
            finally
            {
                sender.Dispose();
                if (!pump.Wait(5000)) { source.Dispose(); throw new TimeoutException(); }
            }
        }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo {
            internal int Size; internal string Reserved, Desktop, Title; internal int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
            internal short ShowWindow, Reserved2; internal IntPtr Reserved2Pointer, StandardInput, StandardOutput, StandardError;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
        [StructLayout(LayoutKind.Sequential)] internal struct LinkedToken { internal IntPtr Token; }
        [StructLayout(LayoutKind.Sequential)] internal struct JobBasicLimit {
            internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] internal struct JobExtendedLimit {
            internal JobBasicLimit BasicLimitInformation; internal IoCounters IoInfo; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ByHandleFileInformation {
            internal uint FileAttributes; internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
            internal uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
        }
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, int size);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation information);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int type, ref JobExtendedLimit info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] internal static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll")] internal static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll")] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool RevertToSelf();
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentThread();
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenThreadToken(IntPtr thread, uint access, bool asSelf, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(IntPtr token, int type, out LinkedToken information, int length, out int returned);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool ImpersonateLoggedOnUser(IntPtr token);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, string text, uint flags, uint timeout, out IntPtr result);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);
    }
}
