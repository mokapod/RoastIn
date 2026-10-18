"""Static file resolution, locked to the application directory.

The stock SimpleHTTPRequestHandler serves everything under whatever
`directory` it was constructed with. Before this override existed that
was the user's entire home directory, which meant a request for
/~/.ssh/id_rsa was a file read away. Everything here exists to make the
servable set exactly "files under APP_DIR, minus dotfiles".
"""
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

from ..config import APP_DIR, APP_FOLDER


def resolve_static_path(path):
    """Map a request path to a file under APP_DIR, or os.devnull.

    Returns os.devnull for anything that is not a legitimate static
    asset. The base handler turns that into an empty response, which is
    indistinguishable from a missing file — deliberate, since it avoids
    telling a prober which paths exist.
    """
    clean = unquote(urlparse(path).path)
    prefix = f'/{APP_FOLDER}/'

    if clean.startswith(prefix):
        rel = clean[len(prefix):]
    elif clean == f'/{APP_FOLDER}':
        rel = 'index.html'
    else:
        return os.devnull

    full = os.path.normpath(os.path.join(APP_DIR, rel))

    # Reject any traversal that escaped APP_DIR.
    try:
        if os.path.commonpath([full, str(APP_DIR)]) != str(APP_DIR):
            return os.devnull
    except ValueError:
        return os.devnull

    # Never serve dotfiles or dot-directories. APP_DIR is the repo root,
    # so this is what keeps /.git/ — config, objects, and the full
    # commit history — from being readable over HTTP. The app has no
    # dotfiles it legitimately serves: .api_token and .gitignore are
    # both server-side only.
    parts = Path(full).relative_to(APP_DIR).parts
    if any(part.startswith('.') for part in parts):
        return os.devnull

    return full
