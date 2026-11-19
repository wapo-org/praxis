from __future__ import annotations

import io
import os
import subprocess
import uuid
from contextlib import AbstractContextManager

IMAGE = 'localhost/praxis-review-sandbox:sol-ui-3'
CONTAINER_TTL_SECONDS = 2700
DEFAULT_EXEC_TIMEOUT_SECONDS = 180
CPU_LIMIT = '2'
MEMORY_LIMIT = '8g'
PID_LIMIT = '768'


class Input(io.BytesIO):
    def write_eof(self):
        pass

    def drain(self):
        pass


class Output:
    def __init__(self, process, stream):
        self.process = process
        self.stream = stream

    def read(self):
        return getattr(self.process.result(), self.stream).decode('utf-8', errors='replace')


class Process:
    def __init__(self, args, env, timeout):
        self.args = args
        self.env = env
        self.timeout = timeout
        self.stdin = Input()
        self.stdout = Output(self, 'stdout')
        self.stderr = Output(self, 'stderr')
        self.completed = None

    def result(self):
        if self.completed is None:
            self.completed = subprocess.run(
                self.args, env=self.env, input=self.stdin.getvalue(), capture_output=True,
                timeout=self.timeout + 15, check=False,
            )
        return self.completed

    def wait(self):
        return self.result().returncode


class Sandbox(AbstractContextManager):
    def __init__(self):
        self.name = f'praxis-review-{uuid.uuid4().hex}'

    def __enter__(self):
        subprocess.run([
            'podman', 'run', '--detach', '--rm', '--pull=never', '--name', self.name,
            '--cgroup-manager=cgroupfs',
            '--network', 'slirp4netns:allow_host_loopback=false', '--cap-drop=all',
            '--security-opt=no-new-privileges', '--cpus', CPU_LIMIT, '--memory', MEMORY_LIMIT,
            '--pids-limit', PID_LIMIT, IMAGE, 'sleep', str(CONTAINER_TTL_SECONDS),
        ], check=True, capture_output=True)
        return self

    def __exit__(self, *exc):
        subprocess.run(['podman', 'rm', '--force', self.name], timeout=30, check=False, capture_output=True)

    def exec(self, *args, env=None, timeout=None, user=None):
        timeout = timeout or DEFAULT_EXEC_TIMEOUT_SECONDS
        command = ['podman', 'exec', '--interactive']
        if user:
            command.extend(['--user', user])
        child_env = dict(os.environ)
        for name, value in (env or {}).items():
            child_env[name] = value
            command.extend(['--env', name])
        command.extend([self.name, 'timeout', '--kill-after=5s', f'{timeout}s', *args])
        return Process(command, child_env, timeout)
