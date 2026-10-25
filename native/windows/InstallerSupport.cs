// Installer-only helpers. Never copied into a callable privileged endpoint.
using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

public static class AbilockInstallerSupport
{
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
        internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        internal uint Volume, HighSize, LowSize, Links, HighIndex, LowIndex;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder name, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileEx(string source, string destination, uint flags);

    public static void CopyVerified(string bundleRoot, string source, string destination, string expectedHash)
    {
        using (SafeFileHandle handle = CreateFile(source, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
        {
            FileInformation info; StringBuilder final = new StringBuilder(32768);
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || info.Links != 1 || (info.Attributes & 0x410) != 0 ||
                GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0) == 0) throw new InvalidOperationException("Unsafe package input.");
            string actual = final.ToString(); if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
            if (!actual.StartsWith(Path.GetFullPath(bundleRoot).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(actual, Path.GetFullPath(source), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unsafe package input.");
            using (FileStream input = new FileStream(handle, FileAccess.Read, 65536, false))
            using (SHA256 digest = SHA256.Create())
            {
                string hash = BitConverter.ToString(digest.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                if (hash != expectedHash) throw new InvalidOperationException("Package integrity check failed.");
                input.Position = 0;
                using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileSystemRights.Write,
                    FileShare.None, 65536, FileOptions.None, AdministratorFileSecurity()))
                { input.CopyTo(output); output.Flush(true); }
            }
        }
    }
    private static FileSecurity AdministratorFileSecurity()
    {
        FileSecurity security = new FileSecurity();
        security.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
        security.SetAccessRuleProtection(true, false);
        foreach (string sid in new string[] { "S-1-5-18", "S-1-5-32-544" })
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }
    [StructLayout(LayoutKind.Sequential)] private struct DirectoryAttributes {
        internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateDirectory(string path, ref DirectoryAttributes attributes);
    public static void CreateProtectedDirectory(string path, DirectorySecurity security)
    {
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try {
            DirectoryAttributes attributes = new DirectoryAttributes { Length = Marshal.SizeOf(typeof(DirectoryAttributes)), Descriptor = pinned.AddrOfPinnedObject(), Inherit = false };
            // ERROR_ALREADY_EXISTS is a failure, never permission to adopt a
            // directory another process inserted after the preflight check.
            if (!CreateDirectory(path, ref attributes)) throw new InvalidOperationException("Protected directory creation failed.");
        } finally { pinned.Free(); }
    }
    public static void CreateProtectedDirectories(string root, string directory)
    {
        string full = Path.GetFullPath(directory);
        string prefix = Path.GetFullPath(root).TrimEnd('\\');
        if (!String.Equals(prefix, full, StringComparison.OrdinalIgnoreCase) &&
            !full.StartsWith(prefix + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Invalid public directory.");
        if (Directory.Exists(full)) return;
        CreateProtectedDirectories(root, Path.GetDirectoryName(full));
        DirectorySecurity security = new DirectorySecurity();
        security.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
        security.SetAccessRuleProtection(false, false);
        foreach (string sid in new string[] { "S-1-5-18", "S-1-5-32-544" })
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        CreateProtectedDirectory(full, security);
    }
    public static FileStream OpenInstallLock(string filename)
    {
        FileStream stream = new FileStream(filename, FileMode.OpenOrCreate, FileSystemRights.Read | FileSystemRights.Write,
            FileShare.None, 4096, FileOptions.None, AdministratorFileSecurity());
        FileInformation info;
        if (!GetFileInformationByHandle(stream.SafeFileHandle, out info) || info.Links != 1 || (info.Attributes & 0x400) != 0)
        { stream.Dispose(); throw new InvalidOperationException("Invalid installation lock."); }
        return stream;
    }
    public static void WriteAtomicFile(string destination, string contents)
    { WriteAtomicFileCore(destination, contents, AdministratorFileSecurity(), false); }

    public static void WritePublicMetadata(string destination, string contents, string ownerSid, string serviceSid)
    {
        if (!String.Equals(Path.GetFileName(destination), "windows-installation.json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid public metadata name.");
        SecurityIdentifier owner = new SecurityIdentifier(ownerSid), service = new SecurityIdentifier(serviceSid);
        if (!owner.Value.StartsWith("S-1-5-21-", StringComparison.Ordinal) ||
            !service.Value.StartsWith("S-1-5-21-", StringComparison.Ordinal) || owner.Equals(service))
            throw new InvalidOperationException("Invalid public metadata identity.");
        FileSecurity security = AdministratorFileSecurity();
        security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.Read, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(service, FileSystemRights.Read, AccessControlType.Allow));
        WriteAtomicFileCore(destination, contents, security, true);
    }

    private static void WriteAtomicFileCore(string destination, string contents, FileSecurity security, bool replaceSecurity)
    {
        string temporary = destination + ".new-" + Guid.NewGuid().ToString("N");
        byte[] bytes = new UTF8Encoding(false).GetBytes(contents);
        try
        {
            // Owner and DACL are installed at creation, before even one byte is
            // written. A filtered owner token cannot win a Set-Acl race.
            using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.Write,
                FileShare.None, 4096, FileOptions.None, security))
            { output.Write(bytes, 0, bytes.Length); output.Flush(true); }
            // ReplaceFile preserves the old destination DACL. Public metadata
            // must instead retain the new explicit read-only SID grants, even
            // when replacing a legacy administrator-only record.
            if (replaceSecurity) {
                if (!MoveFileEx(temporary, destination, 0x1 | 0x8)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            else if (File.Exists(destination)) File.Replace(temporary, destination, null);
            else File.Move(temporary, destination);
        }
        finally { Array.Clear(bytes, 0, bytes.Length); if (File.Exists(temporary)) File.Delete(temporary); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct UserInfo1 {
        [MarshalAs(UnmanagedType.LPWStr)] internal string Name, Password;
        internal uint PasswordAge, Privilege;
        [MarshalAs(UnmanagedType.LPWStr)] internal string HomeDirectory, Comment;
        internal uint Flags;
        [MarshalAs(UnmanagedType.LPWStr)] internal string ScriptPath;
    }
    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserAdd(string server, uint level, ref UserInfo1 user, out uint parameterError);

    // Account and transaction tag are committed by one OS operation. Recovery
    // never changes a password on an account that already exists.
    public static void CreateDedicatedAccount(string password, string description)
    {
        if (String.IsNullOrEmpty(password) || description == null || !description.StartsWith("Abilock dedicated account "))
            throw new InvalidOperationException("Invalid account setup.");
        UserInfo1 user = new UserInfo1 { Name = "_abilock", Password = password, Privilege = 1,
            Comment = description, Flags = 0x10000 | 0x200 | 0x1 };
        uint parameter; uint status = NetUserAdd(null, 1, ref user, out parameter);
        if (status != 0) throw new InvalidOperationException("Dedicated account creation failed.");
    }
    public static string ProtectSetupPassword(string value)
    {
        byte[] clear = Encoding.UTF8.GetBytes(value);
        try { return Convert.ToBase64String(ProtectedData.Protect(clear, null, DataProtectionScope.LocalMachine)); }
        finally { Array.Clear(clear, 0, clear.Length); }
    }
    public static string UnprotectSetupPassword(string value)
    {
        byte[] clear = ProtectedData.Unprotect(Convert.FromBase64String(value), null, DataProtectionScope.LocalMachine);
        try { return new UTF8Encoding(false, true).GetString(clear); }
        finally { Array.Clear(clear, 0, clear.Length); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct LsaObjectAttributes { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] private struct LsaString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [DllImport("advapi32.dll")] private static extern uint LsaOpenPolicy(IntPtr system, ref LsaObjectAttributes attributes, uint access, out IntPtr handle);
    [DllImport("advapi32.dll")] private static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);
    [DllImport("advapi32.dll")] private static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")] private static extern uint LsaClose(IntPtr policy);

    public static void GrantRights(string sidValue)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidValue); byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        LsaObjectAttributes attributes = new LsaObjectAttributes(); attributes.Length = Marshal.SizeOf(attributes);
        IntPtr policy; uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x00000810, out policy);
        if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        try
        {
            foreach (string name in new string[] { "SeBatchLogonRight", "SeDenyInteractiveLogonRight", "SeDenyRemoteInteractiveLogonRight", "SeDenyNetworkLogonRight" })
            {
                LsaString value = new LsaString(); value.Buffer = Marshal.StringToHGlobalUni(name);
                value.Length = (ushort)(name.Length * 2); value.MaximumLength = (ushort)(value.Length + 2);
                try { status = LsaAddAccountRights(policy, bytes, new LsaString[] { value }, 1); if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status)); }
                finally { Marshal.FreeHGlobal(value.Buffer); }
            }
        }
        finally { LsaClose(policy); }
    }

    public static string PromptPassword()
    {
        Application.EnableVisualStyles();
        using (Form form = new Form())
        {
            form.Text = "Abilock - Set administrator password"; form.Width = 460; form.Height = 280;
            form.FormBorderStyle = FormBorderStyle.FixedDialog; form.MaximizeBox = false; form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            Label intro = new Label { Left = 20, Top = 18, Width = 410, Height = 35, Text = "Create the password for the Abilock configuration window." };
            Label label = new Label { Left = 20, Top = 60, Width = 400, Text = "Password (8 to 256 characters)" };
            TextBox first = new TextBox { Left = 20, Top = 85, Width = 400, UseSystemPasswordChar = true, MaxLength = 512 };
            Label confirm = new Label { Left = 20, Top = 120, Width = 400, Text = "Confirm password" };
            TextBox second = new TextBox { Left = 20, Top = 145, Width = 400, UseSystemPasswordChar = true, MaxLength = 512 };
            Button save = new Button { Left = 310, Top = 190, Width = 110, Text = "Continue" };
            form.Controls.AddRange(new Control[] { intro, label, first, confirm, second, save }); form.AcceptButton = save;
            save.Click += delegate {
                int characters = 0; for (int i = 0; i < first.Text.Length; i++) { characters++; if (Char.IsHighSurrogate(first.Text[i]) && i + 1 < first.Text.Length && Char.IsLowSurrogate(first.Text[i + 1])) i++; }
                if (characters < 8 || characters > 256 || first.Text != second.Text)
                { MessageBox.Show(form, "Use 8 to 256 characters and enter the same password twice.", "Abilock"); return; }
                form.DialogResult = DialogResult.OK; form.Close();
            };
            if (form.ShowDialog() != DialogResult.OK) throw new OperationCanceledException("Setup was cancelled.");
            string value = first.Text; first.Clear(); second.Clear(); return value;
        }
    }
}
