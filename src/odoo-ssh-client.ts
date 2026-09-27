import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Configuration schema
const ConfigSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9.-]+$/, 'SSH host must be a plain hostname'),
  port: z.number().int().positive().default(22),
  username: z.string().regex(/^[A-Za-z0-9._-]+$/, 'SSH user must be a plain username (the build ID on Odoo.sh)'),
  privateKeyPath: z.string().min(1, 'SSH private key path is required'),
  knownHostsPath: z.string().optional(),
  strictHostKeyChecking: z.enum(['yes', 'accept-new']).default('accept-new'),
  odooDatabase: z.string().regex(/^[A-Za-z0-9._-]*$/).optional(),
  timeout: z.number().positive().default(30000),
  debug: z.boolean().default(false),
});

export type Config = z.input<typeof ConfigSchema>;
type ParsedConfig = z.infer<typeof ConfigSchema>;

// Response types
export interface ProjectInfo {
  name: string;
  repository: string;
  branches: string[];
}

export interface BranchInfo {
  name: string;
  current: boolean;
  lastCommit: string;
  lastCommitMessage: string;
}

export interface BuildInfo {
  commit: string;
  author: string;
  date: string;
  message: string;
}

export interface DatabaseInfo {
  name: string;
  size: string;
  lastBackup?: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

/**
 * Quote a value for the remote POSIX shell. Everything between single quotes is literal;
 * embedded single quotes are closed, escaped and reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Git ref names: no option injection, no revision syntax. */
export function assertBranch(branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.length > 200) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return branch;
}

/** Paths relative to ~/src/user: no absolute paths, no traversal, no option injection. */
export function assertRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('~') ||
    normalized.startsWith('-') ||
    normalized.split('/').some((part) => part === '..') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Invalid path (must be relative to ~/src/user, without '..'): ${path}`);
  }
  return normalized;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const REPO = 'cd ~/.repositories/git_*';
const USER_SRC = 'cd ~/src/user';

export class OdooShSSHClient {
  private config: ParsedConfig;

  constructor(config: Config) {
    this.config = ConfigSchema.parse(config);
  }

  private debug(message: string): void {
    if (this.config.debug) console.error(`[SSH DEBUG] ${message}`);
  }

  /** Arguments passed to the local `ssh` binary (no local shell involved). */
  buildSshArgs(remoteCommand: string): string[] {
    const args = [
      '-i', this.config.privateKeyPath,
      '-p', String(this.config.port),
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', `StrictHostKeyChecking=${this.config.strictHostKeyChecking}`,
      '-o', `ConnectTimeout=${Math.ceil(this.config.timeout / 1000)}`,
    ];
    if (this.config.knownHostsPath) {
      args.push('-o', `UserKnownHostsFile=${this.config.knownHostsPath}`);
    }
    args.push('-l', this.config.username, '--', this.config.host, remoteCommand);
    return args;
  }

  /**
   * Execute a command on the Odoo.sh build via the OpenSSH client.
   * The remote command is a single argv entry, so nothing is interpreted by a local shell;
   * every user-supplied value inside it must go through shellQuote() or a validator.
   */
  private async executeCommand(command: string): Promise<string> {
    this.debug(`Executing: ${command.length > 300 ? command.slice(0, 300) + '…' : command}`);
    try {
      const { stdout, stderr } = await execFileAsync('ssh', this.buildSshArgs(command), {
        timeout: this.config.timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      if (stderr) this.debug(`stderr: ${stderr.slice(0, 500)}`);
      return stdout;
    } catch (err: any) {
      const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
      throw new Error(`SSH command failed (exit ${err.code ?? '?'}): ${stderr || err.message}`);
    }
  }

  async getProjectInfo(): Promise<ProjectInfo> {
    const remoteUrl = await this.executeCommand(`${REPO} && git remote get-url origin`);
    const branchesOutput = await this.executeCommand(`${REPO} && git branch -r | grep -v HEAD`);
    const branches = branchesOutput
      .split('\n')
      .filter((b) => b.trim())
      .map((b) => b.trim().replace('origin/', ''));
    const nameMatch = remoteUrl.match(/\/([^/]+?)(\.git)?\s*$/);
    return {
      name: nameMatch ? nameMatch[1] : 'unknown',
      repository: remoteUrl.trim(),
      branches,
    };
  }

  async listBranches(): Promise<BranchInfo[]> {
    const output = await this.executeCommand(
      `${REPO} && git for-each-ref refs/remotes/origin --format='%(refname:short)%09%(objectname:short)%09%(subject)'`
    );
    return output
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('origin/HEAD'))
      .map((line) => {
        const [ref, commit, ...subject] = line.split('\t');
        return {
          name: ref.replace(/^origin\//, ''),
          current: false,
          lastCommit: commit ?? '',
          lastCommitMessage: subject.join('\t'),
        };
      });
  }

  async getCurrentBranch(): Promise<string> {
    const output = await this.executeCommand(`${USER_SRC} && git rev-parse --abbrev-ref HEAD`);
    return output.trim();
  }

  async getBuildHistory(branch: string, limit: number = 10): Promise<BuildInfo[]> {
    const ref = shellQuote(`origin/${assertBranch(branch)}`);
    const n = clampInt(limit, 10, 1, 100);
    const output = await this.executeCommand(
      `${REPO} && git log ${ref} -n ${n} --format='%H%x1f%an%x1f%ai%x1f%s'`
    );
    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [commit, author, date, message] = line.split('\x1f');
        return { commit, author, date, message };
      });
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    try {
      const output = await this.executeCommand(
        `psql -At -d postgres -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate"`
      );
      return output
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [name, size] = line.split('|');
          return { name: name.trim(), size: size ? size.trim() : 'unknown' };
        });
    } catch {
      return [];
    }
  }

  async getLogs(logType: 'odoo' | 'install' | 'pip' = 'odoo', lines: number = 100): Promise<LogEntry[]> {
    const files = { odoo: '~/logs/odoo.log', install: '~/logs/install.log', pip: '~/logs/pip.log' };
    const logFile = files[logType];
    if (!logFile) throw new Error(`Invalid log type: ${logType}`);
    const n = clampInt(lines, 100, 1, 5000);
    try {
      const output = await this.executeCommand(`tail -n ${n} ${logFile}`);
      return output
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
          const levelMatch = line.match(/\b(DEBUG|INFO|WARNING|ERROR|CRITICAL)\b/);
          return {
            timestamp: timestampMatch ? timestampMatch[1] : '',
            level: levelMatch ? levelMatch[1] : 'INFO',
            message: line,
          };
        });
    } catch (err) {
      return [{
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Failed to read log file: ${(err as Error).message}`,
      }];
    }
  }

  /**
   * Run Python in `odoo-bin shell` on the build. The code travels base64-encoded, so it is never
   * parsed by any shell. Without ODOO_SH_DATABASE, odoo-bin uses the build's configured database.
   */
  async executeOdooShell(pythonCode: string): Promise<string> {
    const b64 = Buffer.from(pythonCode, 'utf8').toString('base64');
    const db = this.config.odooDatabase ? ` -d ${shellQuote(this.config.odooDatabase)}` : '';
    try {
      return await this.executeCommand(`printf %s ${shellQuote(b64)} | base64 -d | odoo-bin shell${db} --no-http`);
    } catch (err) {
      throw new Error(`Odoo shell execution failed: ${(err as Error).message}`);
    }
  }

  async getSystemInfo(): Promise<Record<string, string>> {
    const commands = {
      hostname: 'hostname',
      uptime: 'uptime',
      disk: 'df -h ~',
      memory: 'free -h',
      python: 'python3 --version',
      odoo: 'odoo-bin --version 2>&1 | head -n 1',
    };
    const results: Record<string, string> = {};
    for (const [key, cmd] of Object.entries(commands)) {
      try {
        results[key] = (await this.executeCommand(cmd)).trim();
      } catch (err) {
        results[key] = `Error: ${(err as Error).message}`;
      }
    }
    return results;
  }

  /** Trigger a new build: empty commit on the branch and push. */
  async triggerBuild(branch: string): Promise<string> {
    const b = shellQuote(assertBranch(branch));
    return await this.executeCommand(
      `${USER_SRC} && git checkout ${b} && git commit --allow-empty -m 'Trigger build from MCP' && git push origin HEAD`
    );
  }

  async getGitStatus(): Promise<string> {
    return await this.executeCommand(`${USER_SRC} && git status`);
  }

  async writeFile(filePath: string, content: string): Promise<string> {
    const path = shellQuote(assertRelativePath(filePath));
    const b64 = shellQuote(Buffer.from(content, 'utf8').toString('base64'));
    return await this.executeCommand(`${USER_SRC} && printf %s ${b64} | base64 -d > ${path}`);
  }

  async readFile(filePath: string): Promise<string> {
    return await this.executeCommand(`${USER_SRC} && cat -- ${shellQuote(assertRelativePath(filePath))}`);
  }

  async listFiles(dirPath: string = '.'): Promise<string> {
    return await this.executeCommand(`${USER_SRC} && ls -la -- ${shellQuote(assertRelativePath(dirPath))}`);
  }

  async createDirectory(dirPath: string): Promise<string> {
    return await this.executeCommand(`${USER_SRC} && mkdir -p -- ${shellQuote(assertRelativePath(dirPath))}`);
  }

  async gitAdd(files: string | string[] = '.'): Promise<string> {
    const list = (Array.isArray(files) ? files : [files]).map((f) => shellQuote(assertRelativePath(f)));
    if (list.length === 0) throw new Error('No files to add');
    return await this.executeCommand(`${USER_SRC} && git add -- ${list.join(' ')}`);
  }

  async gitCommit(message: string): Promise<string> {
    if (!message.trim()) throw new Error('Commit message is required');
    return await this.executeCommand(`${USER_SRC} && git commit -m ${shellQuote(message)}`);
  }

  async gitPush(branch?: string): Promise<string> {
    const target = branch ? shellQuote(assertBranch(branch)) : 'HEAD';
    return await this.executeCommand(`${USER_SRC} && git push origin ${target}`);
  }

  async gitCheckout(branch: string, createNew: boolean = false): Promise<string> {
    const flag = createNew ? '-b ' : '';
    return await this.executeCommand(`${USER_SRC} && git checkout ${flag}${shellQuote(assertBranch(branch))}`);
  }

  async gitPull(): Promise<string> {
    return await this.executeCommand(`${USER_SRC} && git pull --ff-only`);
  }
}
