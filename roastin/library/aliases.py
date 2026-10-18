"""aliases.json persistence and the merge operation.

Two loaders, deliberately:

  load_aliases        — lenient. Missing or corrupt file yields ({}, {}).
                        Used by every read-only path (page injection,
                        GET /api/aliases) that must not fail a page
                        load over a bad file.

  load_aliases_strict — raises on a corrupt file. Used by the merge
                        path, which is about to write and must not
                        proceed on a failed read.

Writes go through save_aliases, which is atomic (tmp + os.replace) and
preserves every top-level key it does not manage — audit_names.py
writes a `_misses` block into the same file, and that must survive a
merge.
"""
import json
import os
import threading

from ..config import ALIASES_PATH

# One lock for the read-modify-write cycle that a merge performs.
# Read-only paths do not take it: save_aliases writes via os.replace,
# so a reader sees either the complete old file or the complete new
# one — never a partial write.
_aliases_lock = threading.Lock()


def load_aliases():
    """Return (artist_aliases, composer_aliases), or empty dicts on error."""
    if not ALIASES_PATH.exists():
        return {}, {}
    try:
        with ALIASES_PATH.open(encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f'⚠️  Could not read {ALIASES_PATH}: {e}')
        return {}, {}
    return (
        data.get('artistAliases', {}),
        data.get('composerAliases', {}),
    )


def load_aliases_strict():
    """Load aliases.json for the write path, raising on any error.

    Returns (base_data, artist_aliases, composer_aliases):

      base_data         — the whole parsed JSON document. Carries any
                          top-level keys this code doesn't manage, such
                          as the _misses block written by
                          audit_names.py, so the writer can preserve
                          them without re-reading the file.

      artist_aliases    — base_data['artistAliases'], or {} when absent.
      composer_aliases  — base_data['composerAliases'], or {} when absent.

    The two sub-maps are convenience views; the caller mutates them in
    place, and the writer reassembles the document around base_data.

    Differs from load_aliases in two ways:

      * A corrupt file is a hard failure rather than a silent empty
        result. The merge path is about to write, and proceeding on
        a failed read would destroy the file on the way out.

      * A missing file is still treated as an empty starting state —
        the first-ever merge legitimately begins with no file.

    Exceptions are wrapped in RuntimeError so the HTTP layer maps them
    to 500 rather than 400. json.JSONDecodeError is a ValueError
    subclass, and the HTTP layer's ValueError handler returns 400 —
    which would misattribute a server-side state problem to the client.
    """
    if not ALIASES_PATH.exists():
        return {}, {}, {}

    try:
        with ALIASES_PATH.open(encoding='utf-8') as f:
            data = json.load(f)
    except OSError as e:
        raise RuntimeError(f'Cannot read {ALIASES_PATH}: {e}') from e
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f'{ALIASES_PATH} is not valid JSON '
            f'(line {e.lineno}, column {e.colno}: {e.msg}). '
            f'Fix or remove the file and retry.'
        ) from e

    return (
        data,
        data.get('artistAliases', {}),
        data.get('composerAliases', {}),
    )


def save_aliases(artist_aliases, composer_aliases, base_data):
    """Write aliases.json atomically, preserving other top-level keys.

    `base_data` is the full parsed document previously returned by
    load_aliases_strict. It carries every key this function does not
    manage — including the _misses block written by audit_names.py —
    and those keys survive the write untouched.

    The document is passed in rather than re-read here to close a
    read-read window. The old form called json.load a second time,
    after the strict loader had already validated and parsed the
    same file. In between, an external writer (a text editor, a
    cloud-sync daemon, a manual JSON edit) could leave the file in a
    state the second read would reject. The merge was then abandoned
    — the correct outcome — but the RuntimeError referred to the
    save path rather than the merge, and pointed at a line and
    column for a problem that had not existed when the merge began.

    Passing the already-validated document removes the second read
    entirely. There is nothing to re-check: the object was produced
    by json.load microseconds ago, and only this process holds a
    reference to it.

    Top-level keys (canonicals) are sorted alphabetically for
    readability. Variant lists are left in insertion order, with the
    canonical first.
    """
    data = dict(base_data)

    # Sort top-level keys case-insensitively.
    data['artistAliases'] = dict(sorted(
        artist_aliases.items(), key=lambda kv: kv[0].casefold()
    ))
    data['composerAliases'] = dict(sorted(
        composer_aliases.items(), key=lambda kv: kv[0].casefold()
    ))

    tmp = str(ALIASES_PATH) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, ALIASES_PATH)


def merge_alias(field, target, source, on_change):
    """Merge `source` into `target` in aliases.json.

    field:  'artist' or 'composer'
    target: the canonical name to merge into
    source: the variant to merge from
    on_change: called after a successful write — the HTTP layer passes
               its cache invalidation hook.

    Returns a summary dict describing what changed.
    """
    if field not in ('artist', 'composer'):
        raise ValueError(f'Invalid field: {field}')

    target = (target or '').strip()
    source = (source or '').strip()
    if not target:
        raise ValueError("Missing 'target'")
    if not source:
        raise ValueError("Missing 'source'")

    # The entire read-modify-write cycle runs under the lock. Without it,
    # two concurrent merges both load the same snapshot, each mutates its
    # own copy, and the second writer overwrites the first writer's merge.
    #
    # The strict loader is what protects the file: a corrupt read raises
    # here, before any mutation, and the file is left untouched. The
    # lenient loader used by the read-only endpoints would have handed
    # this function empty dicts and let it overwrite the file on the
    # way out.
    #
    # base_data is the whole document, threaded through to save_aliases
    # so the writer does not re-read the file. See the docstring on
    # save_aliases for why that matters.
    with _aliases_lock:
        base_data, artist_aliases, composer_aliases = load_aliases_strict()
        aliases = artist_aliases if field == 'artist' else composer_aliases

        # Ensure target group exists with target in its own variant list.
        if target not in aliases:
            aliases[target] = [target]
        elif target not in aliases[target]:
            aliases[target].insert(0, target)

        # Append source to target's variant list if not already present.
        added = False
        if source not in aliases[target]:
            aliases[target].append(source)
            added = True

        # Remove the standalone group for source, if it exists and isn't
        # target. Copy over any other variants that belonged to source
        # first, so they don't disappear when the group is deleted.
        removed_group = False
        if source != target and source in aliases:
            for v in aliases.get(source, []):
                if v not in aliases[target]:
                    aliases[target].append(v)
            del aliases[source]
            removed_group = True

        save_aliases(artist_aliases, composer_aliases, base_data)

        # Snapshot under the lock. `aliases[target]` is a live list that a
        # concurrent merge could still mutate before the response is
        # serialized on the way out.
        target_variants = list(aliases[target])

    # Invalidate the alias cache now that the file on disk has changed.
    # Done after the lock is released — the cache has its own lock, and
    # nothing in the merge path needs to see the two held together.
    on_change()

    return {
        'field': field,
        'target': target,
        'source': source,
        'added': added,
        'removed_group': removed_group,
        'target_variants': target_variants,
    }
