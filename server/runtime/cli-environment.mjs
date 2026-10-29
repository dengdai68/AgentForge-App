import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

// GUI apps do not inherit interactive shell profiles. Preserve the operator's
// existing precedence; only append documented, deterministic fallback paths.
export function cliEnvironment(command, extra = {}, { environment = process.env, platform = process.platform, homeDirectory = homedir() } = {}) {
  const result = { ...environment, ...extra };
  delete result.ELECTRON_RUN_AS_NODE;
  delete result.AGENTFORGE_BOOTSTRAP_TOKEN;
  // Plugin installations are immutable inputs, not Python cache directories.
  // Inherited by local tools; not a filesystem sandbox or an access restriction.
  result.PYTHONDONTWRITEBYTECODE = '1';
  if (platform === 'darwin') {
    const fallback = [
      ...(isAbsolute(command) ? [dirname(command)] : []),
      join(homeDirectory, '.local', 'bin'), join(homeDirectory, '.npm-global', 'bin'), join(homeDirectory, '.volta', 'bin'),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'
    ];
    result.PATH = [...new Set([...(result.PATH ? result.PATH.split(':') : []), ...fallback])].join(':');
  }
  return result;
}
