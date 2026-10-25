// Opened from Finder, the Dock, Spotlight or a link, ArcMod gets none of the Chromium switches tools/run-mod.sh
// passes. Arc hands its engine Swift's CommandLine.arguments, so ArcMod.dylib's constructor extends it here, before
// Arc's main() runs. (Re-executing with extra arguments instead would cost LaunchServices its hold on the process.)
import Foundation

// Returns the switches it added as a NULL-terminated array that lives as long as the process, or nil when they were
// passed already. ArcMod.dylib adds the same ones to the C and Foundation copies of the arguments.
@_cdecl("ArcModAddLaunchSwitches")
public func ArcModAddLaunchSwitches(_ hostResolverRules: UnsafePointer<CChar>) -> UnsafePointer<UnsafePointer<CChar>?>? {
  let arguments = CommandLine.arguments
  if arguments.dropFirst().contains(where: { $0.hasPrefix("--host-resolver-rules=") }) { return nil }
  let switches = [
    "--use-mock-keychain",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--host-resolver-rules=" + String(cString: hostResolverRules),
  ]
  CommandLine.arguments = arguments + switches
  let added = UnsafeMutablePointer<UnsafePointer<CChar>?>.allocate(capacity: switches.count + 1)
  for (index, value) in switches.enumerated() { added[index] = UnsafePointer(strdup(value)) }
  added[switches.count] = nil
  return UnsafePointer(added)
}
