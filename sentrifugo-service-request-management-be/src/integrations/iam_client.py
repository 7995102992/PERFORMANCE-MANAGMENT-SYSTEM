"""Thin async client for IAM (sibling microservice).

Contracts consumed (Foundation §3):
  GET /users/{id}           -> {id, display_name, email, organisation_id, ...}
  GET /departments/{id}     -> {id, name, head_user_id, member_user_ids[], organisation_id}

If `IAM_BASE_URL` is unset we run in **stub mode**: reads return canned shapes
from in-memory fixtures and writes are no-ops. Local dev + unit tests work
without IAM running. See SRM_Implementation_Queries.txt Q-003.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from ..valkey import dept_cache_key, get_valkey, user_cache_key

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 120


class IAMError(Exception):
    pass


class IAMClient:
    def __init__(self) -> None:
        from ..config import settings
        self.base_url = settings.IAM_BASE_URL.rstrip("/")
        self.token = settings.IAM_SERVICE_TOKEN
        self.stub_mode = not self.base_url
        self._http: httpx.AsyncClient | None = None
        if self.stub_mode:
            logger.warning("iam_client.stub_mode IAM_BASE_URL not set")

    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            headers = {}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            self._http = httpx.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=httpx.Timeout(5.0, connect=2.0),
            )
        return self._http

    async def _request(
        self, method: str, path: str, *, access_token: str | None = None, params: dict | None = None,
    ) -> httpx.Response:
        """Make an HTTP request to IAM, optionally using a user's access token."""
        client = await self._client()
        headers = {}
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        try:
            return await client.request(method, path, headers=headers, params=params)
        except httpx.HTTPError as e:
            raise IAMError(f"IAM unreachable: {e}") from e

    async def _lookup_session(self, user_id: str) -> dict | None:
        """Last-resort: find user info from Valkey session data."""
        try:
            cache = get_valkey()
            token_set_key = f"user:access_tokens:{user_id}"
            tokens = await cache.smembers(token_set_key)
            for token in tokens:
                raw = await cache.get(f"session:{token}")
                if raw:
                    session = json.loads(raw)
                    if session.get("user_id") == user_id:
                        return {
                            "id": user_id,
                            "email": session.get("email", ""),
                            "first_name": session.get("first_name", ""),
                            "last_name": session.get("last_name", ""),
                            "display_name": session.get("full_name", ""),
                            "organisation_id": session.get("org_id", ""),
                        }
        except Exception:
            pass
        return None

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ---------- Users ----------
    async def get_user(self, user_id: str, *, access_token: str | None = None) -> dict | None:
        try:
            cache = get_valkey()
            cached = await cache.get(user_cache_key(user_id))
            if cached:
                return json.loads(cached)
        except Exception:  # noqa: BLE001 — valkey optional on cold path
            cache = None  # type: ignore[assignment]

        if self.stub_mode:
            data = _stub_user(user_id)
        else:
            from . import employee_replica
            try:
                # Try /users first; if that fails, try /employees and resolve.
                # If both fail, try Valkey session as last resort.
                resp = await self._request("GET", f"/users/{user_id}", access_token=access_token)
                if resp.status_code < 400:
                    data = resp.json()
                else:
                    emp_resp = await self._request("GET", f"/employees/{user_id}", access_token=access_token)
                    if emp_resp.status_code < 400:
                        emp_data = emp_resp.json()
                        linked_user_id = str(emp_data.get("userId") or emp_data.get("user_id") or "")
                        if linked_user_id:
                            user_resp = await self._request("GET", f"/users/{linked_user_id}", access_token=access_token)
                            if user_resp.status_code < 400:
                                data = user_resp.json()
                                data["_employee"] = emp_data
                            else:
                                data = emp_data
                        else:
                            data = emp_data
                    else:
                        # Both /users and /employees failed — try Valkey session lookup.
                        data = await self._lookup_session(user_id)
                        if not data:
                            # Then the replica, before giving up. The `except
                            # IAMError` branch below already does this, but it
                            # only catches transport failures; a 401 is a
                            # perfectly good HTTP response and never reaches it.
                            #
                            # That distinction is the whole reason the SLA tick's
                            # breach email did not send. The tick has no user
                            # token, so it calls with `access_token=None`, and
                            # IAM has no service principal — `IAM_SERVICE_TOKEN`
                            # authenticates nothing server-side — so both
                            # requests 401 on *every* invocation, not just during
                            # an outage. The session lookup then only succeeds if
                            # the assignee happens to be logged in at the moment
                            # the deadline fires. Landing here is the norm for
                            # any caller without a user token, not an edge case.
                            fallback = await employee_replica.get(str(user_id))
                            if fallback is not None:
                                logger.info(
                                    "iam_client.get_user %s served from replica "
                                    "(IAM returned %s, no session)",
                                    user_id,
                                    emp_resp.status_code,
                                )
                                return fallback
                            logger.warning(
                                "iam_client.get_user %s unresolved — IAM %s, no "
                                "session, not in replica",
                                user_id,
                                emp_resp.status_code,
                            )
                            return None
            except IAMError:
                # IAM unreachable — serve the last-known copy so identity-
                # dependent flows (approval submit, assign, escalate) still work.
                fallback = await employee_replica.get(str(user_id))
                if fallback is not None:
                    logger.warning(
                        "iam_client.get_user %s served from replica (IAM unreachable)", user_id
                    )
                    return fallback
                raise
            # Write-through: persist the fresh copy as the durable fallback.
            try:
                await employee_replica.upsert_read(str(user_id), data)
            except Exception:  # noqa: BLE001
                logger.debug("emp_replica.write_through_failed %s", user_id, exc_info=True)

        try:
            # Only cache a hit. `json.dumps(None)` is the string "null", which
            # is truthy on read and decodes back to None — so caching a miss
            # pins that user as non-existent for the whole TTL, and every
            # `get_user` for them returns None without ever asking IAM again.
            # Downstream that reads as "user is not eligible": assign, reassign,
            # escalate and approval-submit all reject them. A single transient
            # miss (the 401 path above returns None on a live response, not an
            # IAMError) is enough to trigger it, and it outlives the outage.
            if cache is not None and data is not None:
                await cache.setex(user_cache_key(user_id), _CACHE_TTL_SECONDS, json.dumps(data))
        except Exception:  # noqa: BLE001
            pass
        return data

    async def users_exist(self, user_ids: list[str], *, access_token: str | None = None) -> dict[str, bool]:
        """Batch existence check — used by workflow approver validation."""
        out: dict[str, bool] = {}
        for uid in user_ids:
            out[uid] = (await self.get_user(uid, access_token=access_token)) is not None
        return out

    async def get_users(self, user_ids: list[str], *, access_token: str | None = None) -> dict[str, dict]:
        """Batch fetch — returns only the users that exist."""
        out: dict[str, dict] = {}
        for uid in user_ids:
            data = await self.get_user(uid, access_token=access_token)
            if data:
                out[uid] = data
        return out

    async def list_department_members(self, department_id: str, *, access_token: str | None = None) -> list[dict]:
        """Return users in a department. Stub mode reads `member_user_ids`."""
        dept = await self.get_department(department_id, access_token=access_token)
        if dept is None:
            return []
        members: list[dict] = []
        for uid in dept.get("member_user_ids", []) or []:
            u = await self.get_user(uid, access_token=access_token)
            if u:
                members.append(u)
        return members

    async def get_managed_category_ids(self, user_id: str) -> list[str]:
        """Stub — real IAM would return category ids the user manages.

        v1 fallback: we resolve via the reverse — for each department where
        this user is `head_user_id`, find categories pointing to that dept.
        Since that requires a Mongo lookup (Category has `department_ids`),
        the caller does that walk; IAM just returns the list of departments
        the user heads.

        **`/users/{id}/managed-departments` does not exist in IAM.** Verified
        404 against a live instance, with and without auth. The `>= 400` branch
        below swallows it into `[]`, so against real IAM this method always
        returns nothing and `_manager_scope_department_ids` collapses to the
        caller's own session department — the "or a department they head" half
        of the manager scope is dead code today. Left in place because the
        intent is right and it starts working the day IAM grows the endpoint;
        note it will also need an access token then, or it will 401 straight
        back into the same empty list.
        """
        if self.stub_mode:
            out: list[str] = []
            for dept in _STUB_DEPTS.values():
                if dept.get("head_user_id") == user_id:
                    out.append(dept["id"])
            return out
        client = await self._client()
        try:
            resp = await client.get(f"/users/{user_id}/managed-departments")
        except httpx.HTTPError as e:
            raise IAMError(f"IAM unreachable: {e}") from e
        if resp.status_code >= 400:
            return []
        data = resp.json()
        return [d["id"] for d in data.get("items", [])]

    # ---------- Departments ----------
    async def get_department(self, department_id: str, *, access_token: str | None = None) -> dict | None:
        try:
            cache = get_valkey()
            cached = await cache.get(dept_cache_key(department_id))
            if cached:
                return json.loads(cached)
        except Exception:  # noqa: BLE001
            cache = None  # type: ignore[assignment]

        if self.stub_mode:
            data = _stub_department(department_id)
        else:
            from . import department_replica
            try:
                resp = await self._request("GET", f"/departments/{department_id}", access_token=access_token)
                if resp.status_code == 403 and access_token and self.token:
                    # User token lacks dept-read scope; retry with service token.
                    resp = await self._request("GET", f"/departments/{department_id}")
            except IAMError:
                # IAM unreachable — serve the last-known copy so dependent flows
                # (e.g. workflow creation snapshotting the dept head) still work.
                fallback = await department_replica.get(str(department_id))
                if fallback is not None:
                    logger.warning(
                        "iam_client.get_department %s served from replica (IAM unreachable)",
                        department_id,
                    )
                    return fallback
                raise
            if resp.status_code == 404:
                return None
            if resp.status_code in (401, 403):
                logger.warning("iam_client.get_department %s -> %s (access denied)", department_id, resp.status_code)
                # The caller's token lacks dept-read scope and there's no
                # service token to retry with. Serve the last-known replica
                # copy so dept-aware views (ticket detail, capability checks)
                # render a department instead of a blank.
                fallback = await department_replica.get(str(department_id))
                if fallback is not None:
                    logger.warning(
                        "iam_client.get_department %s served from replica (access denied)",
                        department_id,
                    )
                    return fallback
                return None
            if resp.status_code >= 400:
                raise IAMError(f"IAM /departments/{department_id} -> {resp.status_code}")
            data = resp.json()
            # Write-through: persist the fresh copy as the durable fallback.
            try:
                await department_replica.upsert_from_read(data)
            except Exception:  # noqa: BLE001
                logger.debug("dept_replica.write_through_failed %s", department_id, exc_info=True)

        try:
            if cache is not None:
                await cache.setex(
                    dept_cache_key(department_id), _CACHE_TTL_SECONDS, json.dumps(data)
                )
        except Exception:  # noqa: BLE001
            pass
        return data

    async def list_departments(
        self, *, access_token: str | None = None, organisation_id: str | None = None,
        skip: int = 0, limit: int = 20, search: str = "",
    ) -> list[dict]:
        if self.stub_mode:
            return list(_STUB_DEPTS.values())
        from . import department_replica
        params: dict[str, Any] = {"skip": skip, "limit": limit}
        if search:
            params["search"] = search
        if organisation_id:
            params["organisation_id"] = organisation_id
        try:
            resp = await self._request("GET", "/departments/", access_token=access_token, params=params)
        except IAMError:
            # IAM unreachable — fall back to the last-known set. Best-effort and
            # unpaginated; callers tolerate a stale list better than a 5xx.
            logger.warning("iam_client.list_departments served from replica (IAM unreachable)")
            return await department_replica.list_by_org(organisation_id)
        if resp.status_code >= 400:
            raise IAMError(f"IAM /departments/ -> {resp.status_code}")
        data = resp.json()
        # Write-through: list responses carry the head too, so browsing the dept
        # picker / catalog naturally backfills the replica for every department.
        try:
            for dept in data:
                await department_replica.upsert_from_read(dept)
        except Exception:  # noqa: BLE001
            logger.debug("dept_replica.list_write_through_failed", exc_info=True)
        return data

    # ---------- Business units ----------
    async def get_business_unit(
        self, business_unit_id: str, *, access_token: str | None = None
    ) -> dict | None:
        """Resolve a business unit by id (for name display + validation).

        Best-effort: returns None when IAM is unreachable or the caller's
        token lacks BU-read scope and no service token is available. Callers
        that need a hard guarantee (create/update) validate the BU↔department
        link against the department doc instead, which every reader can read.
        """
        cache_key = f"iam:bu:{business_unit_id}"
        try:
            cache = get_valkey()
            cached = await cache.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception:  # noqa: BLE001
            cache = None  # type: ignore[assignment]

        if self.stub_mode:
            return None

        try:
            resp = await self._request(
                "GET", f"/business-units/{business_unit_id}", access_token=access_token
            )
            if resp.status_code == 403 and access_token and self.token:
                # User token lacks BU-read scope; retry with service token.
                resp = await self._request("GET", f"/business-units/{business_unit_id}")
        except IAMError:
            logger.warning(
                "iam_client.get_business_unit %s skipped (IAM unreachable)",
                business_unit_id,
            )
            return None
        if resp.status_code == 404:
            return None
        if resp.status_code in (401, 403):
            logger.warning(
                "iam_client.get_business_unit %s -> %s (access denied)",
                business_unit_id, resp.status_code,
            )
            return None
        if resp.status_code >= 400:
            raise IAMError(f"IAM /business-units/{business_unit_id} -> {resp.status_code}")
        data = resp.json()
        try:
            if cache is not None:
                await cache.setex(cache_key, _CACHE_TTL_SECONDS, json.dumps(data))
        except Exception:  # noqa: BLE001
            pass
        return data

    # ---------- Employees ----------
    async def list_employees(
        self, *, access_token: str | None = None, organisation_id: str | None = None,
        skip: int = 0, limit: int = 20, search: str = "",
        department_id: str | None = None,
        has_policies: bool | None = None,
    ) -> list[dict]:
        if self.stub_mode:
            rows = _stub_employees_for(department_id)
            return rows[skip : skip + limit] if limit else rows[skip:]
        from . import employee_replica
        params: dict[str, Any] = {"skip": skip, "limit": limit}
        if search:
            params["search"] = search
        if organisation_id:
            params["organisation_id"] = organisation_id
        if department_id:
            # IAM's GET /employees/ expects `department_ids` (plural, comma-
            # separated). The singular key is silently ignored, which made
            # the dept picker in CategoryForm return all org employees.
            params["department_ids"] = department_id
        if has_policies is not None:
            params["has_policies"] = "true" if has_policies else "false"
        params["employment_status"] = "active"
        try:
            resp = await self._request("GET", "/employees/", access_token=access_token, params=params)
        except IAMError:
            # IAM unreachable — fall back to the last-known set. Best-effort and
            # unpaginated; leadership filtering still works off cached policies.
            logger.warning("iam_client.list_employees served from replica (IAM unreachable)")
            return await employee_replica.list_by_org(organisation_id, department_id)
        if resp.status_code >= 400:
            raise IAMError(f"IAM /employees/ -> {resp.status_code}")
        data = resp.json()
        # Write-through: list responses carry l1/l2 + policies, so browsing the
        # employee picker naturally backfills the replica (incl. leadership).
        try:
            for emp in data:
                uid = str(emp.get("userId") or emp.get("user_id") or emp.get("id") or "")
                if uid:
                    await employee_replica.upsert_read(uid, emp)
        except Exception:  # noqa: BLE001
            logger.debug("emp_replica.list_write_through_failed", exc_info=True)
        return data

    async def get_employee(self, employee_id: str, *, access_token: str | None = None) -> dict | None:
        if self.stub_mode:
            return _STUB_USERS.get(employee_id)
        from . import employee_replica
        try:
            resp = await self._request("GET", f"/employees/{employee_id}", access_token=access_token)
        except IAMError:
            # IAM unreachable — serve last-known (covers reporting-manager
            # resolution, which is built on get_employee).
            fallback = await employee_replica.get(str(employee_id))
            if fallback is not None:
                logger.warning(
                    "iam_client.get_employee %s served from replica (IAM unreachable)", employee_id
                )
                return fallback
            raise
        if resp.status_code == 404:
            return None
        if resp.status_code in (401, 403):
            # Caller's token lacks employee-read scope and there's no service
            # token to retry with. Serve the last-known replica copy so
            # identity-dependent flows (approval submit / reporting-manager
            # resolution) keep working instead of failing as "no L1 manager".
            fallback = await employee_replica.get(str(employee_id))
            if fallback is not None:
                logger.warning(
                    "iam_client.get_employee %s served from replica (access denied)",
                    employee_id,
                )
                return fallback
            return None
        if resp.status_code >= 400:
            raise IAMError(f"IAM /employees/{employee_id} -> {resp.status_code}")
        data = resp.json()
        try:
            await employee_replica.upsert_read(str(employee_id), data)
        except Exception:  # noqa: BLE001
            logger.debug("emp_replica.write_through_failed %s", employee_id, exc_info=True)
        return data

    # ---------- Reporting chain / leadership (used by SR approval flow) ----------
    async def get_reporting_managers(
        self, user_id: str, *, access_token: str | None = None
    ) -> dict[str, str | None]:
        """Resolve the requester's L1/L2 managers from the employees collection.

        IAM's GET /employees/{user_id} returns the enriched employee doc with
        l1_manager_id / l2_manager_id (both nullable). Returns empty dict-like
        shape when the employee record is missing — callers must handle null.
        """
        emp = await self.get_employee(user_id, access_token=access_token)
        if not emp:
            return {"l1_user_id": None, "l2_user_id": None}

        def _norm(v):
            if v is None:
                return None
            s = str(v)
            return s if s and s != "None" else None

        # IAM serialises EmployeeResponse in camelCase (l1ManagerId), so we
        # check both casings — the snake_case form covers any other source
        # (e.g., direct Mongo doc handed in).
        return {
            "l1_user_id": _norm(
                emp.get("l1_manager_id") or emp.get("l1ManagerId")
            ),
            "l2_user_id": _norm(
                emp.get("l2_manager_id") or emp.get("l2ManagerId")
            ),
        }

    async def list_leadership_users(
        self,
        organisation_id: str,
        *,
        access_token: str | None = None,
        policy_name: str = "dev-leadership",
    ) -> list[dict]:
        """Return users in the org who hold the leadership policy.

        v1 implementation: paginate IAM's GET /employees/ and filter
        client-side on the embedded `policies[].name`. Dev orgs are small
        (<1k users) so this is fine; when we add a `policy_id` filter to
        IAM /employees/ this can collapse to one call. Resolves the policy
        name verbatim (`dev-leadership` in dev, swap per-env later).
        """
        if self.stub_mode:
            return []
        out: list[dict] = []
        skip = 0
        page = 100
        while True:
            employees = await self.list_employees(
                access_token=access_token,
                organisation_id=organisation_id,
                skip=skip,
                limit=page,
            )
            if not employees:
                break
            for emp in employees:
                policies = emp.get("policies") or []
                names = {(p.get("name") or "").lower() for p in policies}
                if policy_name.lower() in names:
                    uid = str(
                        emp.get("userId")
                        or emp.get("user_id")
                        or emp.get("id")
                        or ""
                    )
                    if not uid:
                        continue
                    first = emp.get("firstName") or emp.get("first_name") or ""
                    last = emp.get("lastName") or emp.get("last_name") or ""
                    work_email = (
                        emp.get("workEmail")
                        or emp.get("work_email")
                        or emp.get("email")
                        or ""
                    )
                    name = (f"{first} {last}").strip() or work_email
                    out.append(
                        {
                            "user_id": uid,
                            "name": name,
                            "email": work_email,
                            "designation": emp.get("designationName")
                            or emp.get("designation_name"),
                            "department": emp.get("departmentName")
                            or emp.get("department_name"),
                        }
                    )
            if len(employees) < page:
                break
            skip += page
        return out

    async def list_report_levels(
        self,
        manager_user_id: str,
        organisation_id: str,
        *,
        access_token: str | None = None,
    ) -> dict[str, int]:
        """Map of report user id -> 1 or 2 for everyone `manager_user_id` manages.

        1 means the manager is that employee's L1, 2 means L2 (L1 wins if both).

        IAM exposes the chain downward-only (employee -> l1/l2), with no
        "list my reports" filter, so this pages the org and filters
        client-side — same shape as list_leadership_users. Every page is
        written through to the employee replica, so a manager who lands here
        once makes the next call servable from Mongo.
        """
        if self.stub_mode:
            return {}
        mid = str(manager_user_id)
        out: dict[str, int] = {}
        skip = 0
        page = 100
        while True:
            employees = await self.list_employees(
                access_token=access_token,
                organisation_id=organisation_id,
                skip=skip,
                limit=page,
            )
            if not employees:
                break
            for emp in employees:
                l1 = str(emp.get("l1_manager_id") or emp.get("l1ManagerId") or "")
                l2 = str(emp.get("l2_manager_id") or emp.get("l2ManagerId") or "")
                if mid not in (l1, l2):
                    continue
                uid = str(
                    emp.get("userId") or emp.get("user_id") or emp.get("id") or ""
                )
                if uid:
                    out[uid] = 1 if l1 == mid else 2
            if len(employees) < page:
                break
            skip += page
        return out


# ---------- Stub fixtures (dev mode only) ----------
# A single shared fixture set so a local dev session behaves predictably.
# Extend freely — these are NOT used when IAM_BASE_URL is set.
#
# Ids are ObjectId-shaped hex, not readable slugs: every id that crosses an API
# boundary is typed `PydanticObjectId` (CategoryCreate.department_id and
# friends), so a slug like "dept_demo_it" is rejected with a 422 before the
# handler ever runs. The names below carry the readability the slugs used to.
STUB_ORG_ID = "5f0000000000000000000001"

STUB_USER_ADMIN_ID = "5f0000000000000000000011"
STUB_USER_MANAGER_ID = "5f0000000000000000000012"
STUB_USER_EMPLOYEE_ID = "5f0000000000000000000013"
# Second IT employee — lets a test tag one person and leave another off the
# roster, which is the whole point of the primary/secondary distinction.
STUB_USER_EMPLOYEE2_ID = "5f0000000000000000000014"

STUB_BU_MAIN_ID = "5f0000000000000000000021"
STUB_BU_HR_ID = "5f0000000000000000000022"

STUB_DEPT_IT_ID = "5f0000000000000000000031"
STUB_DEPT_HR_ID = "5f0000000000000000000032"
STUB_DEPT_SHARED_ID = "5f0000000000000000000033"


def _stub_employee(
    user_id: str, first: str, last: str, email: str, dept_id: str, *, is_super_admin: bool = False
) -> dict:
    """One stub user carrying both the identity and employee-row shapes.

    Callers read these under several key spellings — `get_user` wants
    display_name/organisation_id, the roster resolver wants
    userId/firstName/workEmail (categories/service.py `_employee_contact`), and
    department filtering wants department_id. Emitting all of them keeps a
    single fixture usable by every path instead of three near-duplicates.
    """
    return {
        "id": user_id,
        "userId": user_id,
        "display_name": f"{first} {last}",
        "firstName": first,
        "lastName": last,
        "email": email,
        "workEmail": email,
        "empCode": f"EMP{user_id[-3:]}",
        "organisation_id": STUB_ORG_ID,
        "department_id": dept_id,
        "departmentId": dept_id,
        "is_super_admin": is_super_admin,
    }


_STUB_USERS: dict[str, dict] = {
    STUB_USER_ADMIN_ID: _stub_employee(
        STUB_USER_ADMIN_ID, "Demo", "Admin", "admin@demo.local", STUB_DEPT_IT_ID,
        is_super_admin=True,
    ),
    STUB_USER_MANAGER_ID: _stub_employee(
        STUB_USER_MANAGER_ID, "Demo", "Manager", "manager@demo.local", STUB_DEPT_IT_ID,
    ),
    STUB_USER_EMPLOYEE_ID: _stub_employee(
        STUB_USER_EMPLOYEE_ID, "Demo", "Employee", "employee@demo.local", STUB_DEPT_IT_ID,
    ),
    STUB_USER_EMPLOYEE2_ID: _stub_employee(
        STUB_USER_EMPLOYEE2_ID, "Second", "Employee", "employee2@demo.local", STUB_DEPT_IT_ID,
    ),
}

_STUB_DEPTS: dict[str, dict] = {
    STUB_DEPT_IT_ID: {
        "id": STUB_DEPT_IT_ID,
        "name": "IT",
        "department_code": "IT",
        "head_user_id": STUB_USER_MANAGER_ID,
        "member_user_ids": [
            STUB_USER_MANAGER_ID,
            STUB_USER_EMPLOYEE_ID,
            STUB_USER_EMPLOYEE2_ID,
        ],
        "organisation_id": STUB_ORG_ID,
        "business_units": [STUB_BU_MAIN_ID],
        "primary_business_unit": STUB_BU_MAIN_ID,
    },
    STUB_DEPT_HR_ID: {
        "id": STUB_DEPT_HR_ID,
        "name": "HR",
        "department_code": "HR",
        "head_user_id": STUB_USER_MANAGER_ID,
        "member_user_ids": [STUB_USER_MANAGER_ID],
        "organisation_id": STUB_ORG_ID,
        "business_units": [STUB_BU_HR_ID],
        "primary_business_unit": STUB_BU_HR_ID,
    },
    # Belongs to BOTH business units — used to exercise the multi-BU visibility
    # intersection (a department common to every selected business unit).
    STUB_DEPT_SHARED_ID: {
        "id": STUB_DEPT_SHARED_ID,
        "name": "Facilities",
        "department_code": "FAC",
        "head_user_id": STUB_USER_MANAGER_ID,
        "member_user_ids": [STUB_USER_MANAGER_ID, STUB_USER_EMPLOYEE_ID],
        "organisation_id": STUB_ORG_ID,
        "business_units": [STUB_BU_MAIN_ID, STUB_BU_HR_ID],
        "primary_business_unit": STUB_BU_MAIN_ID,
    },
}


def _stub_employees_for(department_id: str | None) -> list[dict]:
    """Stub `list_employees`, honouring the department filter.

    The old stub returned every user for every query, which made roster
    validation vacuous — any id "belonged" to any department. Membership comes
    from the department's own `member_user_ids` so the two fixtures can't drift.

    Accepts the comma-separated form too, matching the real endpoint: the
    employees router now forwards several departments in one call.
    """
    if not department_id:
        return list(_STUB_USERS.values())
    out: list[dict] = []
    seen: set[str] = set()
    for did in str(department_id).split(","):
        dept = _STUB_DEPTS.get(did.strip())
        if not dept:
            continue
        for uid in dept.get("member_user_ids", []):
            if uid in _STUB_USERS and uid not in seen:
                seen.add(uid)
                out.append(_STUB_USERS[uid])
    return out


def _stub_user(user_id: str) -> dict | None:
    return _STUB_USERS.get(user_id)


def _stub_department(department_id: str) -> dict | None:
    return _STUB_DEPTS.get(department_id)


# Singleton accessor.
_instance: IAMClient | None = None


def get_iam_client() -> IAMClient:
    global _instance
    if _instance is None:
        _instance = IAMClient()
    return _instance


async def close_iam_client() -> None:
    global _instance
    if _instance is not None:
        await _instance.aclose()
        _instance = None
