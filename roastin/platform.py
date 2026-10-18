"""OS integration helpers.

Each function shells out to the right platform tool. These are
fire-and-forget: no return value, no error surfaced to the caller —
if `open` fails, the user simply sees nothing happen.
"""
import os
import subprocess
import sys


def os_open(path):
    """Open a file or folder in the OS file manager / default app."""
    if sys.platform == 'darwin':
        subprocess.Popen(['open', path])
    elif sys.platform == 'win32':
        subprocess.Popen(['explorer', path.replace('/', '\\')])
    else:
        subprocess.Popen(['xdg-open', path])


def os_reveal(path):
    """Reveal a file or folder, with it selected where supported."""
    if sys.platform == 'darwin':
        subprocess.Popen(['open', '-R', path])
    elif sys.platform == 'win32':
        subprocess.Popen(['explorer', '/select,', path.replace('/', '\\')])
    else:
        # Most Linux file managers don't support "reveal selected",
        # so open the containing folder instead.
        folder = path if os.path.isdir(path) else os.path.dirname(path)
        subprocess.Popen(['xdg-open', folder])


def os_launch_app(app_name):
    """Bring an already-running app to the front, or launch it."""
    if sys.platform == 'darwin':
        subprocess.Popen(['open', '-a', app_name])
    elif sys.platform == 'win32':
        subprocess.Popen(['cmd', '/c', 'start', '', app_name])
    else:
        subprocess.Popen([app_name.lower()])


def os_quit_app(app_name):
    """Request a graceful quit of a running app."""
    if sys.platform == 'darwin':
        subprocess.Popen(
            ['osascript', '-e', f'tell application "{app_name}" to quit'])
    elif sys.platform == 'win32':
        subprocess.Popen(['taskkill', '/IM', f'{app_name}.exe', '/F'])
    else:
        subprocess.Popen(['pkill', '-f', app_name])
