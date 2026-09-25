from __future__ import annotations

import json
import math
from typing import Any, Callable, Set


_CIRCULAR_MARKER = "[Circular]"


class UnserializableValueError(Exception):
    """Raised when a value cannot be deterministically serialized."""
    pass


def _to_canonical(val: Any, seen: Set[int]) -> Any:
    """
    Recursively converts a Python value into a 100% JSON-compatible structure
    (dict / list / str / int / float / bool / None), ready to be passed directly
    to json.dumps().

    Important: We intercept tuples, sets, and objects ourselves before any call
    to json.dumps, because json.dumps natively treats tuples as lists (it never
    calls default() for them) -- which would lose the tuple/list distinction
    at any depth if we delegated this step.
    """
    if val is None or isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        if math.isnan(val):
            return float("nan")
        if math.isinf(val):
            return float("inf") if val > 0 else float("-inf")
        if val == 0 and math.copysign(1, val) < 0:
            return -0.0
        return val
    if isinstance(val, str):
        return val

    val_id = id(val)
    if val_id in seen:
        return _CIRCULAR_MARKER
    seen.add(val_id)

    try:
        if isinstance(val, dict):
            return {k: _to_canonical(v, seen) for k, v in sorted(val.items())}

        if isinstance(val, (list, tuple, set, frozenset)):
            items = [_to_canonical(item, seen) for item in val]
            if isinstance(val, (set, frozenset)):
                items.sort(key=repr)
                return {"$type": "set", "items": items}
            if isinstance(val, tuple):
                return {"$type": "tuple", "items": items}
            return items

        if hasattr(val, "__class__") and val.__class__.__name__ not in ("type", "function"):
            return {"$type": "object", "class": val.__class__.__name__, "repr": repr(val)}

        raise UnserializableValueError(
            f"Cannot serialize value of type {type(val).__name__}"
        )
    finally:
        seen.remove(val_id)


def canonical_serialise(val: Any) -> str:
    """
    Serializes a Python value in a stable and canonical way.
    """
    structure = _to_canonical(val, set())
    return json.dumps(structure, separators=(",", ":"), allow_nan=True)


def invoke_candidate(fn: Callable[..., Any], args_json: str) -> str:
    """
    Invokes the candidate function with JSON arguments and intercepts
    results/errors.

    Returns a JSON string:
    - Success: {"ok": true, "value": canonical_serialized_result}
    - Error: {"ok": false, "name": exception_type, "message": exception_message}
    - KeyboardInterrupt: re-raised to be mapped as throw:Timeout
      at the worker level (see python.worker.ts)
    """
    try:
        args = json.loads(args_json)
        res = fn(*args)
        serialized = canonical_serialise(res)
        return json.dumps({"ok": True, "value": serialized})
    except KeyboardInterrupt:
        raise
    except Exception as e:
        return json.dumps({
            "ok": False,
            "name": type(e).__name__,
            "message": str(e),
        })
