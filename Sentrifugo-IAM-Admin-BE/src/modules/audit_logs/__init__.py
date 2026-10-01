"""Audit Logs read-proxy (BFF) for the org-admin Audit Logs page.

The central Logging Service stores audit rows but authenticates with an
``x-api-key`` (not JWT) and filters blindly by ``organisation_id``. This module
is the read side for the Admin-FE: it authenticates the org admin's JWT, scopes
every query to the caller's organisation, holds the ADMIN-level logging API key
server-side, derives the rich display columns (module / action / entity / status)
from the stored ``action``/``resource``/``metadata``, and enriches ``actor_id``
into user name / email / role from IAM's own user store.

Phase 1: ship the wireframe layout against available + derived + enriched data.
Columns the producers do not yet capture (old/new value, source, user agent) are
returned null and rendered as "—" by the FE.
"""
