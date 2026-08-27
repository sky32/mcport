export type RiskCategory = 'dependency_change' | 'destructive_command' | 'network_access' | 'file_delete' | 'overwrite' | 'checkpoint_restore' | 'operation_reconcile';

export type RiskAssessment = {
  level: 'low' | 'high';
  categories: RiskCategory[];
  reasons: string[];
  networkIntent: boolean;
};

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\.cmd$/i, '');
}

function argAt(args: string[], index = 0): string {
  return String(args[index] ?? '').trim().toLowerCase();
}

function hasArg(args: string[], value: string): boolean {
  return args.some((arg) => String(arg).trim().toLowerCase() === value);
}

function isInformationalNpx(args: string[]): boolean {
  const informationalFlags = ['--version', '-v', '--help', '-h'];
  return args.length === 1 && informationalFlags.includes(argAt(args));
}

function packageMutation(command: string, args: string[]): string | null {
  const first = argAt(args);
  const second = argAt(args, 1);
  if (command === 'npm') {
    if (['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'ci', 'dedupe'].includes(first)) return `npm ${first}`;
  }
  if (command === 'npx' && !isInformationalNpx(args)) return 'npx may download and execute packages';
  if (command === 'pnpm') {
    if (['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'dlx', 'import', 'deploy'].includes(first)) return `pnpm ${first}`;
  }
  if (command === 'yarn') {
    if (['install', 'add', 'remove', 'upgrade', 'up', 'set'].includes(first)) return `yarn ${first}`;
  }
  if (['pip', 'pip3'].includes(command)) {
    if (['install', 'uninstall', 'download', 'wheel'].includes(first)) return `${command} ${first}`;
  }
  if (command === 'poetry' && ['add', 'remove', 'install', 'update', 'lock'].includes(first)) return `poetry ${first}`;
  if (command === 'pdm' && ['add', 'remove', 'install', 'update', 'sync', 'lock'].includes(first)) return `pdm ${first}`;
  if (command === 'uv') {
    if (['add', 'remove', 'sync', 'lock'].includes(first)) return `uv ${first}`;
    if (first === 'pip' && ['install', 'uninstall', 'sync', 'compile'].includes(second)) return `uv pip ${second}`;
  }
  if (command === 'composer' && ['require', 'remove', 'install', 'update'].includes(first)) return `composer ${first}`;
  if (command === 'bundle' && ['install', 'update', 'add', 'remove', 'lock'].includes(first)) return `bundle ${first}`;
  if (command === 'cargo' && ['add', 'remove', 'install', 'update'].includes(first)) return `cargo ${first}`;
  if (command === 'go') {
    if (first === 'get' || first === 'install') return `go ${first}`;
    if (first === 'mod' && ['download', 'tidy', 'vendor'].includes(second)) return `go mod ${second}`;
  }
  return null;
}

function gitDestructive(args: string[]): string | null {
  const first = argAt(args);
  if (first === 'clean') return 'git clean removes untracked files';
  if (first === 'reset' && hasArg(args, '--hard')) return 'git reset --hard discards working-tree changes';
  if (first === 'checkout' && (hasArg(args, '-f') || hasArg(args, '--force'))) return 'git checkout --force discards working-tree changes';
  if (first === 'restore' && (hasArg(args, '--worktree') || !hasArg(args, '--staged'))) return 'git restore can discard working-tree changes';
  return null;
}

function networkOperation(command: string, args: string[]): string | null {
  const first = argAt(args);
  const second = argAt(args, 1);
  if (command === 'git' && ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(first)) return `git ${first} accesses a remote`;
  if (command === 'git' && first === 'submodule' && ['update', 'sync', 'foreach'].includes(second)) return `git submodule ${second} may access remotes`;
  if (['curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'rsync'].includes(command)) return `${command} is a network-capable command`;
  if (command === 'npx' && !isInformationalNpx(args)) return 'npx may download packages';
  if (command === 'npm' && ['install', 'i', 'add', 'update', 'upgrade', 'ci', 'dedupe'].includes(first)) return `npm ${first} may access package registries`;
  if (command === 'pnpm' && ['install', 'i', 'add', 'update', 'up', 'dlx', 'import', 'deploy'].includes(first)) return `pnpm ${first} may access package registries`;
  if (command === 'yarn' && ['install', 'add', 'upgrade', 'up', 'set'].includes(first)) return `yarn ${first} may access package registries`;
  if (['pip', 'pip3'].includes(command) && ['install', 'download', 'wheel'].includes(first)) return `${command} ${first} may access package registries`;
  if (command === 'poetry' && ['add', 'install', 'update', 'lock'].includes(first)) return `poetry ${first} may access package registries`;
  if (command === 'pdm' && ['add', 'install', 'update', 'sync', 'lock'].includes(first)) return `pdm ${first} may access package registries`;
  if (command === 'uv' && ['add', 'sync', 'lock'].includes(first)) return `uv ${first} may access package registries`;
  if (command === 'uv' && first === 'pip' && ['install', 'sync', 'compile'].includes(second)) return `uv pip ${second} may access package registries`;
  if (command === 'composer' && ['require', 'install', 'update'].includes(first)) return `composer ${first} may access package registries`;
  if (command === 'bundle' && ['install', 'update', 'add', 'lock'].includes(first)) return `bundle ${first} may access package registries`;
  if (command === 'cargo' && ['add', 'install', 'update'].includes(first)) return `cargo ${first} may access package registries`;
  if (command === 'go' && ['get', 'install'].includes(first)) return `go ${first} may access module proxies`;
  if (command === 'go' && first === 'mod' && ['download', 'tidy'].includes(second)) return `go mod ${second} may access module proxies`;
  return null;
}

export function assessCommandRisk(commandValue: string, args: string[]): RiskAssessment {
  const command = normalizeCommand(commandValue);
  const categories = new Set<RiskCategory>();
  const reasons: string[] = [];

  const dependency = packageMutation(command, args);
  if (dependency) {
    categories.add('dependency_change');
    reasons.push(`${dependency} changes or resolves project dependencies`);
  }

  if (command === 'git') {
    const destructive = gitDestructive(args);
    if (destructive) {
      categories.add('destructive_command');
      reasons.push(destructive);
    }
  }

  const network = networkOperation(command, args);
  if (network) {
    categories.add('network_access');
    reasons.push(network);
  }

  return {
    level: categories.size ? 'high' : 'low',
    categories: [...categories],
    reasons,
    networkIntent: Boolean(network),
  };
}

export function patchRisk(operations: Array<Record<string, unknown>>): RiskAssessment {
  const categories = new Set<RiskCategory>();
  const reasons: string[] = [];
  for (const operation of operations) {
    if (operation.op === 'delete') {
      categories.add('file_delete');
      reasons.push(`delete ${String(operation.path ?? '')}`.trim());
    }
    if (operation.op === 'move' && operation.overwrite === true) {
      categories.add('overwrite');
      reasons.push(`move overwrites ${String(operation.to ?? '')}`.trim());
    }
    if (operation.op === 'write' && operation.overwrite === true) {
      categories.add('overwrite');
      reasons.push(`write overwrites ${String(operation.path ?? '')}`.trim());
    }
  }
  return { level: categories.size ? 'high' : 'low', categories: [...categories], reasons, networkIntent: false };
}
