"""API token management.

The token is generated on first run and persisted next to the app so a
browser tab stays authenticated across server restarts. Set
ROASTIN_API_TOKEN in the environment to override — useful for
containers and CI.
"""
import os
import secrets

from .config import API_TOKEN_PATH


def _load_or_create_token():
    env_token = os.environ.get('ROASTIN_API_TOKEN')
    if env_token:
        return env_token

    try:
        if API_TOKEN_PATH.exists():
            token = API_TOKEN_PATH.read_text(encoding='utf-8').strip()
            if token:
                return token
    except OSError:
        pass

    token = secrets.token_urlsafe(32)
    try:
        API_TOKEN_PATH.write_text(token + '\n', encoding='utf-8')
        os.chmod(API_TOKEN_PATH, 0o600)
    except OSError:
        pass
    return token


API_TOKEN = _load_or_create_token()
