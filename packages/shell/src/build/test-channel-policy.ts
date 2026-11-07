// `launch()` drives a built app through its test channel: KITOP_TEST names a socket, and the app
// runs any platform call it's sent, bridge.allow aside. A build signed to be distributed doesn't
// have it, so no program can borrow the app's identity (its keychain items, its OS permissions)
// that way. KITOP_TEST_BUILD=1 keeps it, to test a signed build. `kitop build --release`
// (KITOP_RELEASE) takes it out on any OS, signed or not: Linux has no signing to go by.
export interface SignConfig {
  sign?: { identity?: string; windows?: { certificateFile?: string; command?: string[] } };
}

export function keepsTestChannel(c: SignConfig, env: Record<string, string | undefined> = process.env): boolean {
  if (env.KITOP_RELEASE) return false;
  if (env.KITOP_TEST_BUILD) return true;
  const identity = c.sign?.identity ?? env.CODESIGN_IDENTITY;
  const macos = !!identity && identity !== "-";
  const windows = !!(c.sign?.windows?.command?.length || c.sign?.windows?.certificateFile || env.WINDOWS_CERT_PFX);
  return !macos && !windows;
}
