"""Department and ownership access scoping.

Two independent restrictions live here:

**Department scoping** — a client may be tied to one or more departments via
``department_ids`` (it may also carry ``business_unit_ids`` for reference, but
access is **department-level only**). Non-admin users only see clients — and
everything derived from them (projects, timesheets, approvals, reports) — that
either have no department (unscoped, visible to everyone) or include the viewer's
own department, resolved from their IAM employee record.

**Ownership scoping** — the ``/clients`` and ``/projects`` routes are gated by the
``manage_clients`` / ``manage_projects`` permissions. Holding the permission does
not mean seeing the whole organisation: a non-admin holder only sees the projects
they are personally attached to (project head, creator, or an active manager-role
resource assignment) and the clients behind those projects.

org_admin and super_admin bypass both restrictions entirely.
"""

from __future__ import annotations

from typing import Any

from bson import ObjectId

from ..models import Client, Project, ResourceAssignment, StatusEnum
from .user_resolver import resolve_user_scope


MODULE = "timesheet_management"

# Resource-assignment roles that make a user an owner of the project. A plain
# member assignment is deliberately not enough — mirrors approvals/notifications.
MANAGER_ROLES = {"manager", "lead", "project_manager", "team_lead"}


def is_scope_exempt(user, action: str | None = None) -> bool:
    """Admins see every client/project regardless of department. When ``action``
    is given (e.g. ``manage_clients`` / ``manage_projects``), users holding that
    timesheet_management permission also bypass the department restriction."""
    if getattr(user, "is_org_admin", False) or getattr(user, "is_super_admin", False):
        return True
    if action:
        has_perm = getattr(user, "has_permission", None)
        if callable(has_perm) and has_perm(MODULE, action):
            return True
    return False


async def can_access_client(user, client: Client, action: str | None = None) -> bool:
    """Whether ``user`` may act on a single client doc (cheap, single-doc check)."""
    if is_scope_exempt(user, action):
        return True
    if not client.department_ids:
        return True  # no department scope → visible to everyone
    _bu, dept_id = await resolve_user_scope(str(user.id))
    return dept_id is not None and dept_id in client.department_ids


async def hidden_client_ids(user, action: str | None = None) -> list[ObjectId]:
    """Client ``_id``s the user may NOT access — i.e. scoped to departments that
    don't include theirs. Empty for admins / permission-holders (nothing hidden).

    Used as ``{"_id": {"$nin": ...}}`` on clients and ``{"client_id": {"$nin": ...}}``
    on projects, so unscoped and matching clients pass through automatically.
    """
    if is_scope_exempt(user, action):
        return []
    _bu, dept_id = await resolve_user_scope(str(user.id))
    # Scoped clients = those with at least one department. Hidden = scoped clients
    # whose department list does NOT contain the viewer's department.
    filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "department_ids.0": {"$exists": True},
    }
    if dept_id:
        filt["department_ids"] = {"$ne": dept_id}
    docs = await Client.find(filt).to_list()
    return [d.id for d in docs]


async def hidden_project_ids(user, action: str | None = None) -> list[ObjectId]:
    """Project ``_id``s whose client the user may not access."""
    hidden_clients = await hidden_client_ids(user, action)
    if not hidden_clients:
        return []
    docs = await Project.find({"client_id": {"$in": hidden_clients}}).to_list()
    return [d.id for d in docs]


# --- Ownership scoping (permission holders who are not admins) ---

def is_admin(user) -> bool:
    """org_admin / super_admin — never restricted to their own projects."""
    return bool(getattr(user, "is_org_admin", False) or getattr(user, "is_super_admin", False))


async def _own_projects(user) -> list[Project]:
    """Project docs the user is personally attached to.

    Attached means any of: their id is in ``project_head_ids``, they created the
    project, or they hold an active resource assignment with a manager role.
    """
    docs = await Project.find({
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "$or": [{"project_head_ids": user.id}, {"created_by": user.id}],
    }).to_list()
    known = {d.id for d in docs}

    assignments = await ResourceAssignment.find({
        "organisation_id": user.organisation_id,
        "user_id": user.id,
        "role": {"$in": sorted(MANAGER_ROLES)},
        "status": StatusEnum.ACTIVE.value,
        "deleted_on": None,
    }).to_list()
    missing = {a.project_id for a in assignments} - known
    if missing:
        docs.extend(await Project.find({
            "_id": {"$in": list(missing)},
            "organisation_id": user.organisation_id,
            "deleted_on": None,
        }).to_list())
    return docs


async def own_project_ids(user) -> set[ObjectId] | None:
    """Project ``_id``s a non-admin may see.

    Returns:
        None for admins, meaning "no ownership restriction". Otherwise the set of
        project ids the user is attached to — an empty set means they see none.
    """
    if is_admin(user):
        return None
    return {d.id for d in await _own_projects(user)}


async def own_client_ids(user) -> set[ObjectId] | None:
    """Client ``_id``s a non-admin may see: the clients behind their own projects,
    plus the clients they created themselves (so a newly added client stays
    reachable before it has any project).

    Returns None for admins, meaning "no ownership restriction".
    """
    if is_admin(user):
        return None
    ids = {d.client_id for d in await _own_projects(user)}
    created = await Client.find({
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "created_by": user.id,
    }).to_list()
    ids.update(c.id for c in created)
    return ids
