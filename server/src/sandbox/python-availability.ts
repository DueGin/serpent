import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class PythonUnavailableError extends Error {
  readonly code = 'PYTHON_UNAVAILABLE';
  constructor(readonly reason: string) {
    super(`当前部署未启用 Python 沙箱或沙箱暂不可用：${reason}。请稍后重试；若持续失败，请联系管理员`);
    this.name = 'PythonUnavailableError';
  }
}

export interface PythonAvailability { available: boolean; reason?: string }
let availability: Promise<PythonAvailability> | undefined;

export function pythonHostPaths(): { entry: string; resources: string } {
  try {
    return { entry: join(__dirname, 'python-host.cjs'), resources: realpathSync(dirname(require.resolve('pyodide'))) };
  } catch { throw new PythonUnavailableError('缺少本地 Pyodide 运行资源'); }
}

export function pythonHostCommand(entry: string, resources: string, probe = false): { command: string; args: string[] } {
  const node = realpathSync(process.execPath);
  const args = ['--permission', `--allow-fs-read=${resources}`, `--allow-fs-read=${entry}`,
    `--allow-fs-read=${join(dirname(entry), 'python-bootstrap.py')}`, '--allow-worker',
    '--disallow-code-generation-from-strings', '--max-old-space-size=192',
    ...(probe ? ['-e', 'process.exit(0)'] : [entry, resources])];
  // Only deployment configuration can replace the isolator, never an API input.
  const override = process.env.PYTHON_ISOLATOR_COMMAND;
  if (process.platform === 'darwin' && (override || existsSync('/usr/bin/sandbox-exec'))) {
    const literal = (value: string) => `(literal ${JSON.stringify(value)})`;
    const profile = '(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)' +
      '(deny file-read-data)(allow file-read-data ' +
      [node, entry, join(dirname(entry), 'python-bootstrap.py'), '/'].map(literal).join(' ') +
      ` (subpath ${JSON.stringify(resources)}) (subpath "/System/Library") (subpath "/usr/lib") (subpath "/dev"))`;
    return { command: override || '/usr/bin/sandbox-exec', args: ['-p', profile, node, ...args] };
  }
  if (process.platform === 'linux' && (override || existsSync('/usr/bin/bwrap'))) {
    const binds = [node, entry, join(dirname(entry), 'python-bootstrap.py'), resources,
      '/usr/lib', '/usr/lib64', '/lib', '/lib64', '/etc/ld.so.cache']
      .filter(value => existsSync(value)).flatMap(value => ['--ro-bind', value, value]);
    return { command: override || '/usr/bin/bwrap', args: ['--die-with-parent', '--unshare-net',
      '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session',
      '--tmpfs', '/', ...binds, '--dev', '/dev', '--proc', '/proc', '--', node, ...args] };
  }
  throw new PythonUnavailableError('需要 macOS sandbox-exec 或 Linux bubblewrap，并允许非特权用户命名空间和 /proc 挂载');
}

async function probePythonIsolation(): Promise<PythonAvailability> {
  try {
    const { entry, resources } = pythonHostPaths();
    if (!existsSync(entry) || !existsSync(join(dirname(entry), 'python-bootstrap.py'))) {
      throw new PythonUnavailableError('缺少 Python 沙箱入口文件');
    }
    const invocation = pythonHostCommand(entry, resources, true);
    return await new Promise<PythonAvailability>((resolve) => {
      const child = spawn(invocation.command, invocation.args, { env: {}, cwd: resources,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      let timedOut = false;
      child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(0, 1000); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
      child.once('error', () => { clearTimeout(timer); resolve({ available: false, reason: '隔离器进程启动失败，请检查隔离器是否安装且可执行' }); });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && !timedOut ? { available: true } : { available: false,
          reason: timedOut ? '隔离器自检超时' : `隔离器自检失败（命名空间或挂载可能被拒绝）：${stderr.trim().slice(0, 400) || `退出码 ${code}`}` });
      });
    });
  } catch (error) {
    return { available: false, reason: error instanceof PythonUnavailableError ? error.reason : 'Python 隔离自检失败' };
  }
}

/** One lightweight production-equivalent confinement probe per process; never loads Pyodide. */
export function getPythonAvailability(): Promise<PythonAvailability> {
  availability ??= probePythonIsolation();
  return availability;
}

export async function requirePythonAvailable(): Promise<void> {
  const status = await getPythonAvailability();
  if (!status.available) throw new PythonUnavailableError(status.reason ?? '隔离器自检失败');
}
