import { spawn, type SpawnOptions } from 'child_process';

// Run a child process with inherited stdio while preserving Ctrl-C semantics.
//
// The story TUI puts stdin in raw mode (readline with keypress listeners), so
// the tty driver no longer translates Ctrl-C into SIGINT — it's just a 0x03
// byte. If we invoked the child through execSync under that state, remotion
// would never see SIGINT and Ctrl-C would be swallowed.
//
// We also install a no-op SIGINT handler on the parent: the terminal sends
// SIGINT to the whole foreground process group, and we want only the child to
// act on it — the parent should keep running so the user returns to the TUI.
export async function spawnInherit(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<number> {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY && stdin.isRaw;
  if (wasRaw) stdin.setRawMode(false);

  const ignoreSigint = () => {};
  process.on('SIGINT', ignoreSigint);

  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit', ...options });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code !== null) resolve(code);
        else if (signal) resolve(128);
        else resolve(0);
      });
    });
  } finally {
    process.removeListener('SIGINT', ignoreSigint);
    if (wasRaw) stdin.setRawMode(true);
  }
}
