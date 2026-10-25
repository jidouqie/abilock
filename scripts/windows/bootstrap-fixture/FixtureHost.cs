// Test-only same-user fixture. Not a production host or installation entry.
// Root/SID are compiled from a fresh test directory; no caller-selected path.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
internal static class FixtureHost {
 const string Root=@"__FIXTURE_ROOT__";
 const string Sid="__FIXTURE_SID__";
 static readonly string Cases=Path.Combine(Root,"cases");
 static readonly string[] Allowed={"S-1-5-18","S-1-5-32-544",Sid};
 static bool Same(string a,string b){return String.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);}
 static string Scoped(string value){
  if(value.IndexOf(':',2)>=0)throw new InvalidOperationException();
  string full=Path.GetFullPath(value);
  if(!Same(full,Cases)&&!full.StartsWith(Cases+"\\",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException();
  return full;
 }
 static void Check(string value,bool links=true){
  string full=Scoped(value);
  for(string item=full;;item=Path.GetDirectoryName(item)){
   if((File.GetAttributes(item)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException();
   FileSystemSecurity security=Directory.Exists(item)?(FileSystemSecurity)Directory.GetAccessControl(item,AccessControlSections.Owner|AccessControlSections.Access):File.GetAccessControl(item,AccessControlSections.Owner|AccessControlSections.Access);
   var raw=new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(),0);
   if(raw.DiscretionaryAcl==null||Array.IndexOf(Allowed,security.GetOwner(typeof(SecurityIdentifier)).Value)<0)throw new InvalidOperationException();
   foreach(GenericAce entry in raw.DiscretionaryAcl){
    var ace=entry as CommonAce;
    if(ace==null||ace.IsCallback||(ace.AceQualifier!=AceQualifier.AccessAllowed&&ace.AceQualifier!=AceQualifier.AccessDenied))throw new InvalidOperationException();
    if(ace.AceQualifier==AceQualifier.AccessAllowed&&Array.IndexOf(Allowed,ace.SecurityIdentifier.Value)<0)throw new InvalidOperationException();
   }
   if(Same(item,Cases))break;
  }
  if(links&&!Directory.Exists(full))using(var handle=CreateFile(full,0,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
   Info info;if(handle.IsInvalid||!GetFileInformationByHandle(handle,out info)||info.Links!=1||(info.Attributes&0x400)!=0)throw new InvalidOperationException();
  }
 }
 static int Main(string[] args){
  try{
   using(var identity=WindowsIdentity.GetCurrent())if(identity.User.Value!=Sid||new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidOperationException();
   if(File.ReadAllText(Path.Combine(Root,"fixture.marker"))!="Abilock synthetic bootstrap runtime")throw new InvalidOperationException();
   if(args.Length!=2)return 64;
   if(args[0]=="check-private"){Check(args[1]);Console.Write("OK\n");return 0;}
   if(args[0]!="file-lock")return 64;
   string file=Scoped(args[1]);Check(Path.GetDirectoryName(file));
   FileStream held;
   try{held=new FileStream(file,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}
   catch(IOException error){int code=Marshal.GetHRForException(error)&0xffff;if(code==32||code==33)return 75;throw;}
   using(held){
    Check(file,false);Info info;
    if(!GetFileInformationByHandle(held.SafeFileHandle,out info)||info.Links!=1||(info.Attributes&0x400)!=0)throw new InvalidOperationException();
    Console.Write("LOCKED\n");Console.Out.Flush();
    using(Stream input=Console.OpenStandardInput()){byte[] bytes=new byte[64];while(input.Read(bytes,0,bytes.Length)!=0){}}
   }
   return 0;
  }catch{Console.Error.WriteLine("SYNTHETIC_NATIVE_CHECK_FAILED");return 78;}
 }
 [StructLayout(LayoutKind.Sequential)]struct Info{internal uint Attributes;internal System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;internal uint Volume,HighSize,LowSize,Links,HighIndex,LowIndex;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr attributes,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
}
