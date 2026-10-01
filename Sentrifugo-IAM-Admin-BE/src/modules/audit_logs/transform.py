"""Derive the wireframe's display columns from a raw logging-service row.

A stored row is ``{timestamp, module(="iam"), actor_id, action("<domain>.<verb>"),
resource("<entity>:<id>"), debug_level, organisation_id, metadata}`` where
``metadata`` is the canonical envelope ``{stream, correlation_id, details, [changed_fields]}``.
None of the rich columns are stored explicitly; we reconstruct them here.
"""
from __future__ import annotations

import json

from src.modules.audit_logs.schemas import AuditLogRow

# Verb (or verb suffix) → coarse action type for the "Action Type" filter/column.
# Checked as substrings against the verb, longest-intent first.
_FAILED_MARKERS = ("failed", "error", "denied", "rejected", "revoked")
_DELETE_MARKERS = ("deleted", "withdrawn", "removed")
_CREATE_MARKERS = ("created", "uploaded", "added", "upserted", "reapplied", "requested", "initiated")
_UPDATE_MARKERS = ("updated", "changed", "reordered", "reassigned", "activated", "approved")
_AUTH_MARKERS = ("login", "logout", "password", "activation", "email_change", "reset")
_EXPORT_MARKERS = ("export", "downloaded", "report")


def _classify(verb: str) -> str:
    v = verb.lower()
    if any(m in v for m in _AUTH_MARKERS):
        return "auth"
    if any(m in v for m in _EXPORT_MARKERS):
        return "export"
    if any(m in v for m in _DELETE_MARKERS):
        return "delete"
    if any(m in v for m in _CREATE_MARKERS):
        return "create"
    if any(m in v for m in _UPDATE_MARKERS):
        return "update"
    return "other"


def _status(verb: str) -> str:
    return "failed" if any(m in verb.lower() for m in _FAILED_MARKERS) else "success"


def _split_action(action: str | None, fallback_module: str | None) -> tuple[str | None, str | None]:
    """``"users.created"`` -> (module="users", verb="created"). A dotless action
    (rare) keeps the whole string as the verb and falls back to the stored module."""
    if not action:
        return fallback_module, None
    if "." in action:
        domain, _, verb = action.partition(".")
        return domain or fallback_module, verb or None
    return fallback_module, action


def _split_resource(resource: str | None) -> tuple[str | None, str | None]:
    """``"user:67a1…"`` -> (entity_type="user", entity_id="67a1…")."""
    if not resource:
        return None, None
    if ":" in resource:
        etype, _, eid = resource.partition(":")
        return etype or None, eid or None
    return resource, None


def _parse_metadata(raw) -> dict:
    """metadata arrives as a JSON string (LogEntryOut) or already-parsed dict."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return {}
    return {}


def to_row(raw: dict) -> AuditLogRow:
    """Map one raw logging-service row to a normalized AuditLogRow (pre-enrichment)."""
    module, verb = _split_action(raw.get("action"), raw.get("module"))
    entity_type, entity_id = _split_resource(raw.get("resource"))

    envelope = _parse_metadata(raw.get("metadata"))
    details = envelope.get("details") if isinstance(envelope.get("details"), dict) else {}
    changed = envelope.get("changed_fields")
    if not isinstance(changed, list):
        changed = []

    return AuditLogRow(
        timestamp=raw.get("timestamp") or "",
        action=verb,
        action_type=_classify(verb or ""),
        module=module,
        target_entity_type=entity_type,
        target_entity_id=entity_id,
        # A human-friendly target name is only present if a producer put one in
        # details; otherwise null (Phase 1 has no name capture).
        target_entity_name=details.get("name") or details.get("target_name"),
        field_names=[str(f) for f in changed],
        status=_status(verb or ""),
        failure_reason=details.get("reason") or details.get("failure_reason"),
        user_id=raw.get("actor_id"),
        ip_address=details.get("ip_address"),
        correlation_id=envelope.get("correlation_id"),
    )
