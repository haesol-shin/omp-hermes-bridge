"""Webhook Generic V2 signature and timestamp window, as the contract defines them."""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping

WINDOW_SECONDS = 300


def _header(headers: Mapping[str, str], name: str) -> str:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return ""


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def check(headers: Mapping[str, str], body: bytes, secret: str, now: float) -> str | None:
    """Return None when the request is authentic and fresh, else the rejection reason."""
    if not secret:
        return "no secret configured"
    signature = _header(headers, "X-Webhook-Signature-V2")
    timestamp = _header(headers, "X-Webhook-Timestamp")
    if not signature or not timestamp:
        return "missing signature or timestamp"
    # The signature is verified first so an unauthenticated caller learns nothing about the clock.
    if not hmac.compare_digest(signature.encode(), sign(secret, timestamp, body).encode()):
        return "bad signature"
    try:
        age = abs(int(now) - int(timestamp))
    except ValueError:
        return "bad timestamp"
    if age > WINDOW_SECONDS:
        return "timestamp outside window"
    return None


# The Hermes webhook adapter accepts several signature schemes and checks them in a fixed order,
# so a request carrying a valid token of another scheme never reaches the V2 timestamp check.
# A plugin hook sees no request headers. The route therefore pins the scheme with `filters`,
# which Hermes evaluates on the request headers after authentication. Headers are matched on the
# JSON text of the header map, case-insensitively, because the filter lookup is case-sensitive
# while the adapter's header lookup is not. The closing quote keeps `x-webhook-signature` (V1)
# apart from `x-webhook-signature-v2`, and a quote inside a header value is escaped by JSON.
OTHER_SCHEMES = (
    "x-gitlab-token|x-hub-signature-256|linear-signature|svix-[a-z]+"
    "|webhook-(?:id|timestamp|signature)|x-webhook-signature"
)
ROUTE_FILTERS = (
    {"field": "headers", "regex": '(?i)"x-webhook-signature-v2"'},
    {"field": "headers", "regex": '(?i)"x-webhook-timestamp"'},
    {"not": {"field": "headers", "regex": f'(?i)"(?:{OTHER_SCHEMES})"'}},
)
