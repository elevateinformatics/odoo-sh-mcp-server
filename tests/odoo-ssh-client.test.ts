import { execFileSync } from 'child_process';
import {
  OdooShSSHClient,
  shellQuote,
  assertBranch,
  assertRelativePath,
  clampInt,
} from '../src/odoo-ssh-client';

const client = new OdooShSSHClient({
  host: 'my-project-staging-123.dev.odoo.com',
  username: '123',
  privateKeyPath: '/keys/id',
});

describe('shellQuote', () => {
  const hostile = [`a'b`, '$(id)', '`id`', 'x; rm -rf ~', '"quoted"', 'back\slash', "'; id; '"];
  const hasSh = (() => {
    try {
      execFileSync('sh', ['-c', 'true']);
      return true;
    } catch {
      return false;
    }
  })();

  (hasSh ? it : it.skip)('round-trips hostile strings through a POSIX shell literally', () => {
    for (const value of hostile) {
      const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`]).toString();
      expect(out).toBe(value);
    }
  });
});

describe('validators', () => {
  it('accepts normal branches', () => {
    expect(assertBranch('main')).toBe('main');
    expect(assertBranch('feature/x-1.2')).toBe('feature/x-1.2');
  });

  it.each(['-f', '--upload-pack=x', 'a..b', 'x;id', '$(id)', 'a b', ''])('rejects branch %p', (b) => {
    expect(() => assertBranch(b)).toThrow();
  });

  it('accepts relative paths', () => {
    expect(assertRelativePath('my_module/models/x.py')).toBe('my_module/models/x.py');
    expect(assertRelativePath('.')).toBe('.');
  });

  it.each(['/etc/passwd', '../x', 'a/../../b', '~/.ssh/id', '-rf', ''])('rejects path %p', (p) => {
    expect(() => assertRelativePath(p)).toThrow();
  });

  it('clamps numbers', () => {
    expect(clampInt('abc', 10, 1, 100)).toBe(10);
    expect(clampInt(1e9, 10, 1, 100)).toBe(100);
    expect(clampInt(-5, 10, 1, 100)).toBe(1);
  });
});

describe('buildSshArgs', () => {
  it('passes the remote command as a single argv entry after --', () => {
    const args = client.buildSshArgs('echo hi');
    expect(args.slice(-3)).toEqual(['--', 'my-project-staging-123.dev.odoo.com', 'echo hi']);
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args.join(' ')).not.toContain('StrictHostKeyChecking=no');
  });

  it('rejects hosts or users with shell/ssh metacharacters', () => {
    expect(() => new OdooShSSHClient({ host: '-oProxyCommand=id', username: '1', privateKeyPath: 'k' })).toThrow();
    expect(() => new OdooShSSHClient({ host: 'h.com', username: 'a;id', privateKeyPath: 'k' })).toThrow();
  });
});
