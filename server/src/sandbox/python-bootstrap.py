# Trusted bootstrap. The returned closure is held only by the host, never put in user globals.
def _serpent_bootstrap():
    import sys
    import builtins
    import json
    import random
    import time
    import os
    import math
    import inspect
    import importlib
    import io
    import types
    import gc

    blocked = frozenset(('js', 'pyodide', 'pyodide_js', '_pyodide', '_pyodide_core',
        'micropip', 'ctypes', '_ctypes', 'socket', '_socket', 'subprocess', 'threading',
        '_thread', 'multiprocessing', 'asyncio'))
    original_import = builtins.__import__
    original_compile = compile
    original_exec = exec
    original_dumps = json.dumps
    original_loads = json.loads
    memory_error_type = MemoryError
    error_type = BaseException
    interrupt_type = KeyboardInterrupt
    user = {}
    lines = []
    count = 0
    pending_line = ''
    tick = 0
    trace_armed = False

    def denied(*args, **kwargs):
        raise PermissionError('沙箱禁止文件写入、网络或宿主操作')

    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name.split('.')[0] in blocked:
            raise ImportError('沙箱禁止模块: ' + name)
        return original_import(name, globals, locals, fromlist, level)

    def audit(event, args):
        if event == 'sys.settrace' and trace_armed:
            denied()
        if event == 'import' and args[0].split('.')[0] in blocked:
            raise ImportError('沙箱禁止模块: ' + args[0])
        if event == 'open':
            filename, mode, flags = args
            # Reads are only for the bundled stdlib inside WASM MEMFS; no user/host files.
            if (not isinstance(filename, str) or not filename.startswith('/lib/python') or
                    (isinstance(mode, str) and any(c in mode for c in 'wax+')) or
                    (isinstance(flags, int) and flags & (1 | 2 | 64 | 512 | 1024))):
                denied()
        if event.startswith(('socket.', 'subprocess.', 'ctypes.', 'os.exec', 'os.spawn')) or event in (
                'os.system', 'os.fork', 'os.posix_spawn', 'os.remove', 'os.rename', 'os.mkdir',
                'os.rmdir', 'os.chmod', 'os.symlink', 'os.link', 'os.truncate'):
            denied()

    sys.dont_write_bytecode = True
    sys.addaudithook(audit)
    builtins.__import__ = safe_import
    os.urandom = denied
    if hasattr(os, 'getrandom'):
        os.getrandom = denied
    random._urandom = denied
    random.SystemRandom = denied
    original_random_seed = random.Random.seed

    def deterministic_seed(instance, value=None, version=2):
        return original_random_seed(instance, 0 if value is None else value, version)

    random.Random.seed = deterministic_seed
    random.seed = random._inst.seed
    time.time = lambda: tick * 0.12
    time.monotonic = time.time
    time.perf_counter = time.time
    time.sleep = denied
    # Remove the JS bridge finder and all already-loaded bridge modules. Reflection is not
    # considered a security boundary; OS confinement and WASM still apply if this is bypassed.
    sys.meta_path[:] = [finder for finder in sys.meta_path
        if 'pyodide' not in type(finder).__module__ and 'JsFinder' not in type(finder).__name__]
    # Removing an import hook does not revoke its capability: gc and loader specs
    # retain the finder and its globalThis/pyodide_js proxies. Clear those edges
    # before untrusted code can inspect the Python object graph.
    for obj in gc.get_objects():
        kind = type(obj)
        if kind.__module__ == '_pyodide._importhook':
            if kind.__name__ == 'JsFinder':
                obj.jsproxies.clear()
            elif kind.__name__ == 'JsLoader':
                obj.jsproxy = None
        if kind is types.ModuleType and obj.__name__.split('.')[0] in blocked:
            namespace = obj.__dict__
            for key, value in list(namespace.items()):
                if type(value).__module__ == 'pyodide.ffi' and not isinstance(value, type):
                    namespace[key] = None
                elif obj.__name__.split('.')[0] in ('js', 'pyodide', 'pyodide_js', '_pyodide', '_pyodide_core') and callable(value) and not isinstance(value, type):
                    namespace[key] = denied
    for name in list(sys.modules):
        if name.split('.')[0] in blocked:
            sys.modules[name] = None

    # Memory failures are attributed by trusted WASM allocator callbacks in the
    # host, not by Python tracing (which frame reflection could disable).
    trace_armed = True
    sys.settrace = denied

    class LogSink:
        def write(self, text):
            nonlocal count, pending_line
            position = 0
            length = len(text)
            while count < 200 and position < length:
                newline = text.find('\n', position)
                stop = length if newline < 0 else newline
                remaining = 500 - len(pending_line)
                if remaining > 0:
                    pending_line += text[position:min(stop, position + remaining)]
                if newline >= 0:
                    lines.append(pending_line)
                    count += 1
                    pending_line = ''
                    position = newline + 1
                else:
                    break
            return length
        def flush(self):
            nonlocal count, pending_line
            if pending_line and count < 200:
                lines.append(pending_line)
                count += 1
            pending_line = ''

    sink = LogSink()
    sys.stdout = sink
    sys.stderr = sink

    def clean(value, depth=0, budget=None, seen=None):
        if budget is None:
            budget, seen = [500], set()
        budget[0] -= 1
        if budget[0] < 0 or depth > 8:
            return '[truncated]'
        kind = type(value)
        if kind is str:
            return value[:5000]
        if kind in (bool, int, type(None)):
            return value if kind is not int or value.bit_length() < 1024 else None
        if kind is float:
            return value if math.isfinite(value) else None
        if kind not in (dict, list, tuple):
            return None
        identity = id(value)
        if identity in seen:
            return '[circular]'
        seen.add(identity)
        if kind in (list, tuple):
            out = [clean(item, depth + 1, budget, seen) for item in value[:128] if budget[0] > 0]
        else:
            out = {}
            for key, item in value.items():
                if budget[0] <= 0:
                    break
                if type(key) is str:
                    out[key[:500]] = clean(item, depth + 1, budget, seen)
        seen.remove(identity)
        return out

    def drive(operation, payload):
        nonlocal user, count, tick
        output = {'raw': None}
        try:
            data = original_loads(payload)
            if operation == 'load':
                seed, slot = data['seed'], data['slot']
                random.seed((seed & 0xffffffff) ^ ((slot + 1) * 0x9e3779b9 & 0xffffffff))
                main = types.ModuleType('__main__')
                sys.modules['__main__'] = main
                user = main.__dict__
                user['__builtins__'] = builtins.__dict__.copy()
                original_exec(original_compile(data['code'], '<serpent-user>', 'exec'), user)
                output['hasMove'] = callable(user.get('move')) and not inspect.iscoroutinefunction(user.get('move'))
                output['hasInit'] = callable(user.get('init'))
            else:
                tick = data.get('tick', 0) if operation == 'move' else 0
                fn = user.get(operation)
                if fn is None and operation == 'init':
                    result = None
                elif not callable(fn):
                    raise TypeError(operation + '() 未定义')
                else:
                    result = fn(data)
                if inspect.isawaitable(result):
                    raise TypeError('不支持异步返回值')
                if operation == 'move':
                    output['raw'] = clean(result)
                    if len(original_dumps(output['raw'], ensure_ascii=False).encode('utf8')) > 65528:
                        raise ValueError('返回值序列化超过 65536 字节限制')
        except interrupt_type:
            output = {'raw': None, 'timeout': True, 'error': 'Python 调用超时'}
        except memory_error_type:
            output = {'raw': None, 'error': 'Python 内存耗尽，已失格', 'fatal': True}
        except error_type as error:
            output = {'raw': None, 'error': str(error)[:1000]}
        sink.flush()
        output['logs'] = lines[:]
        lines.clear()
        return original_dumps(output, ensure_ascii=False, separators=(',', ':'))

    return drive

_serpent_bootstrap()
