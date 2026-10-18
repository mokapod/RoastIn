"""Request-body parsing and typed field extraction.

Every /api/* POST takes a small JSON object. These helpers normalise the
awkward corners: a missing Content-Length, a JSON null where a number
was expected, a non-object body, an absurdly large declared length.
"""
from __future__ import annotations

import json
from typing import Dict, Optional

from ..config import MAX_JSON_BODY_BYTES
from ..types import JSONValue


def read_json_body(handler) -> Dict[str, JSONValue]:
    """Read and parse the JSON body of a POST request.

    The body is capped at MAX_JSON_BODY_BYTES. Without a cap, a client
    that sends `Content-Length: 2147483647` makes `rfile.read(n)`
    allocate toward that size before any validation runs — a single
    request could exhaust the server's memory. Every request this
    server accepts is a small command payload (a handful of track
    paths, a script name), so 1 MB is orders of magnitude of headroom.
    """
    content_length = handler.headers.get('Content-Length')
    if not content_length:
        return {}

    try:
        length = int(content_length)
    except ValueError:
        return {}

    if length < 0:
        raise ValueError('Invalid Content-Length')
    if length > MAX_JSON_BODY_BYTES:
        raise ValueError(
            f'Request body too large (limit {MAX_JSON_BODY_BYTES} bytes)'
        )

    post_data = handler.rfile.read(length).decode('utf-8')
    if not post_data:
        return {}

    try:
        result = json.loads(post_data)
    except json.JSONDecodeError as e:
        raise ValueError('Invalid JSON payload') from e

    if not isinstance(result, dict):
        # ValueError rather than TypeError on purpose: the POST router
        # maps ValueError to 400 and everything else to 500, and a
        # non-object body is a client error.
        raise ValueError('JSON body must be an object')

    return result


def get_int(data: Dict[str, JSONValue], key: str,
            default: Optional[int] = None) -> int:
    """Fetch an integer from a parsed JSON body.

    json.loads produces None for a JSON null, and the two-argument
    .get(key, default) only substitutes the default when the key is
    *missing* — not when it is present and null. So
    int(data.get('track', 1)) raises TypeError on {"track": null},
    which the router's ValueError handler does not catch, and the
    request returns 500 instead of 400.

    This helper normalizes null to the default and converts the result,
    raising ValueError (mapped to 400) for anything non-numeric.
    """
    value = data.get(key, default)
    if value is None:
        value = default
    if value is None:
        raise ValueError(f"Missing '{key}'")
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid '{key}': expected an integer") from e


def get_float(data: Dict[str, JSONValue], key: str,
              default: Optional[float] = None) -> float:
    """Same contract as get_int, for floating-point fields."""
    value = data.get(key, default)
    if value is None:
        value = default
    if value is None:
        raise ValueError(f"Missing '{key}'")
    try:
        return float(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid '{key}': expected a number") from e
