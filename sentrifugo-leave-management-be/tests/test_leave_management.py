"""Tests for the Sentrifugo Leave Management Service.

Auth pattern: get_current_user is overridden via dependency_overrides in conftest.
DB pattern: get_db_session is overridden with a MagicMock.
Service pattern: each service function is patched in the router's namespace.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient

# ── IDs used across tests ────────────────────────────────────────────────────

ORG_ID = "507f1f77bcf86cd799439011"
PLAN_ID = "507f1f77bcf86cd799439013"
TYPE_ID = "507f1f77bcf86cd799439014"
HOLIDAY_PLAN_ID = "507f1f77bcf86cd799439015"
HOLIDAY_ID = "507f1f77bcf86cd799439016"
CALENDAR_ID = "507f1f77bcf86cd799439017"
SHIFT_ID = "507f1f77bcf86cd799439018"
POLICY_ID = "507f1f77bcf86cd799439019"
ENTITLEMENT_ID = "507f1f77bcf86cd799439020"
REQUEST_ID = "507f1f77bcf86cd799439021"
FLOW_ID = "507f1f77bcf86cd799439022"
EMPLOYEE_ID = "507f1f77bcf86cd799439023"
ASSIGNMENT_ID = "507f1f77bcf86cd799439024"
GRANT_POLICY_ID = "507f1f77bcf86cd799439025"


def _audit() -> dict:
    return {
        "created_on": datetime(2025, 1, 1, tzinfo=timezone.utc),
        "created_by": None,
        "updated_on": None,
        "updated_by": None,
        "deleted_on": None,
        "deleted_by": None,
    }


# ── Holiday Plans ─────────────────────────────────────────────────────────────

class TestHolidayPlans:
    def _response(self) -> dict:
        return {
            "_id": HOLIDAY_PLAN_ID,
            "org_id": ORG_ID,
            "name": "India 2025",
            "year": 2025,
            "business_units": [],
            "departments": [],
            "reminder_settings": {"enabled": False, "days_before": 2},
            "is_active": True,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_holiday_plan(self, client: AsyncClient):
        with patch("src.holiday_plans.router.create_holiday_plan", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/holiday-plans", json={
                "org_id": ORG_ID,
                "name": "India 2025",
                "year": 2025,
            })
        assert resp.status_code == 201
        assert resp.json()["id"] == HOLIDAY_PLAN_ID

    @pytest.mark.asyncio
    async def test_list_holiday_plans(self, client: AsyncClient):
        summary = {"_id": HOLIDAY_PLAN_ID, "name": "India 2025"}
        with patch("src.holiday_plans.router.get_holiday_plans", new_callable=AsyncMock, return_value=[summary]):
            resp = await client.get(f"/holiday-plans?org_id={ORG_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_holiday_plan(self, client: AsyncClient):
        with patch("src.holiday_plans.router.get_holiday_plan", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/holiday-plans/{HOLIDAY_PLAN_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == HOLIDAY_PLAN_ID

    @pytest.mark.asyncio
    async def test_update_holiday_plan(self, client: AsyncClient):
        updated = {**self._response(), "name": "India 2025 Updated"}
        with patch("src.holiday_plans.router.update_holiday_plan", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/holiday-plans/{HOLIDAY_PLAN_ID}", json={"name": "India 2025 Updated"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "India 2025 Updated"

    @pytest.mark.asyncio
    async def test_delete_holiday_plan(self, client: AsyncClient):
        with patch("src.holiday_plans.router.delete_holiday_plan", new_callable=AsyncMock):
            resp = await client.delete(f"/holiday-plans/{HOLIDAY_PLAN_ID}")
        assert resp.status_code == 204


# ── Holidays ──────────────────────────────────────────────────────────────────

class TestHolidays:
    def _response(self) -> dict:
        return {
            "_id": HOLIDAY_ID,
            "plan_id": HOLIDAY_PLAN_ID,
            "org_id": ORG_ID,
            "name": "Independence Day",
            "date": "2025-08-15",
            # Scope is stored as lists (single = list of one, multiple = many).
            "classification": None,
            "applicable_department_ids": ["507f1f77bcf86cd799439031"],
            "business_unit_ids": ["507f1f77bcf86cd799439030"],
            "reminder": {"enabled": False, "days_before": 2},
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_holiday(self, client: AsyncClient):
        with patch("src.holidays.router.create_holiday", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/holidays", json={
                "plan_id": HOLIDAY_PLAN_ID,
                "org_id": ORG_ID,
                "name": "Independence Day",
                "date": "2025-08-15",
                "classification_id": "507f1f77bcf86cd799439040",
                # At least one BU and one department are required; both are lists.
                "business_unit_ids": ["507f1f77bcf86cd799439030"],
                "applicable_department_ids": ["507f1f77bcf86cd799439031"],
            })
        assert resp.status_code == 201
        # Response serializes the id under its storage alias `_id` (by_alias=True).
        assert resp.json()["_id"] == HOLIDAY_ID

    @pytest.mark.asyncio
    async def test_list_holidays_by_plan(self, client: AsyncClient):
        with patch(
            "src.holidays.router.get_holidays_by_plan",
            new_callable=AsyncMock,
            return_value=([self._response()], 1),
        ):
            resp = await client.get(f"/holiday-plans/{HOLIDAY_PLAN_ID}/holidays")
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

    @pytest.mark.asyncio
    async def test_list_holidays_calendar(self, client: AsyncClient):
        with patch("src.holidays.router.get_holidays_by_date_range", new_callable=AsyncMock, return_value=[self._response()]):
            resp = await client.get(
                f"/holidays/calendar?org_id={ORG_ID}&plan_id={HOLIDAY_PLAN_ID}"
                "&from_date=2025-08-01&to_date=2025-08-31"
            )
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_update_holiday(self, client: AsyncClient):
        updated = {**self._response(), "name": "Independence Day (Updated)"}
        with patch("src.holidays.router.update_holiday", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/holidays/{HOLIDAY_ID}", json={"name": "Independence Day (Updated)"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Independence Day (Updated)"

    @pytest.mark.asyncio
    async def test_delete_holiday(self, client: AsyncClient):
        with patch("src.holidays.router.delete_holiday", new_callable=AsyncMock):
            resp = await client.delete(f"/holidays/{HOLIDAY_ID}")
        assert resp.status_code == 204


# ── Work Calendars ────────────────────────────────────────────────────────────

class TestWorkCalendars:
    def _calendar_response(self) -> dict:
        return {
            "_id": CALENDAR_ID,
            "org_id": ORG_ID,
            "name": "Standard 2025",
            "year_type": "CUSTOM",
            "start_date": "2025-01-01",
            "end_date": "2025-12-31",
            "is_active": True,
            "is_default": False,
            "week_config": {
                "week_start_day": "MONDAY",
                "work_week_start": "MONDAY",
                "work_week_end": "FRIDAY",
                "allow_half_day": True,
            },
            "weekend_matrix": {},
            "statutory_config": {"enabled": True, "rule_type": "FIXED", "statutory_days": []},
            **_audit(),
        }

    def _list_item(self) -> dict:
        return {
            "_id": CALENDAR_ID,
            "name": "Standard 2025",
            "period": {"start": "2025-01-01", "end": "2025-12-31"},
            "work_week": {"start": "MONDAY", "end": "FRIDAY"},
            "status": "ACTIVE",
            "employee_count": 0,
        }

    def _shift_response(self) -> dict:
        return {
            "_id": SHIFT_ID,
            "calendar_id": CALENDAR_ID,
            "name": "Morning",
            "start_time": "09:00",
            "end_time": "18:00",
            "break_minutes": 60,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_list_calendars(self, client: AsyncClient):
        with patch("src.work_calendar.router.list_calendars", new_callable=AsyncMock, return_value=[self._list_item()]):
            resp = await client.get("/work-calendars")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_create_calendar(self, client: AsyncClient):
        with patch("src.work_calendar.router.create_calendar", new_callable=AsyncMock, return_value=self._calendar_response()):
            resp = await client.post("/work-calendars", json={
                "name": "Standard 2025",
                "start_date": "2025-01-01",
                "end_date": "2025-12-31",
            })
        assert resp.status_code == 201
        assert resp.json()["id"] == CALENDAR_ID

    @pytest.mark.asyncio
    async def test_get_calendar(self, client: AsyncClient):
        with patch("src.work_calendar.router.get_calendar", new_callable=AsyncMock, return_value=self._calendar_response()):
            resp = await client.get(f"/work-calendars/{CALENDAR_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == CALENDAR_ID

    @pytest.mark.asyncio
    async def test_update_calendar(self, client: AsyncClient):
        updated = {**self._calendar_response(), "name": "Standard 2025 Updated"}
        with patch("src.work_calendar.router.update_calendar", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/work-calendars/{CALENDAR_ID}", json={"name": "Standard 2025 Updated"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Standard 2025 Updated"

    @pytest.mark.asyncio
    async def test_assign_calendar(self, client: AsyncClient):
        result = {"calendar_id": CALENDAR_ID, "scope": "DEPARTMENT", "count": 3}
        with patch("src.work_calendar.router.assign_calendar", new_callable=AsyncMock, return_value=result):
            resp = await client.post("/work-calendars/assign", json={
                "calendar_id": CALENDAR_ID,
                "scope": "DEPARTMENT",
                "scope_ids": ["dept1", "dept2", "dept3"],
            })
        assert resp.status_code == 200
        assert resp.json()["count"] == 3

    @pytest.mark.asyncio
    async def test_assign_employee_calendar(self, client: AsyncClient):
        result = {"calendar_id": CALENDAR_ID, "scope": "EMPLOYEE", "count": 2}
        with patch("src.work_calendar.router.assign_employee_override", new_callable=AsyncMock, return_value=result):
            resp = await client.post("/work-calendars/assign/employee", json={
                "calendar_id": CALENDAR_ID,
                "employee_ids": ["emp1", "emp2"],
                "effective_from": "2025-01-01",
            })
        assert resp.status_code == 200
        assert resp.json()["count"] == 2

    @pytest.mark.asyncio
    async def test_create_shift(self, client: AsyncClient):
        with patch("src.work_calendar.router.create_shift", new_callable=AsyncMock, return_value=self._shift_response()):
            resp = await client.post("/work-calendars/shifts", json={
                "calendar_id": CALENDAR_ID,
                "name": "Morning",
                "start_time": "09:00",
                "end_time": "18:00",
                "break_minutes": 60,
            })
        assert resp.status_code == 201
        assert resp.json()["id"] == SHIFT_ID

    @pytest.mark.asyncio
    async def test_list_shifts_by_calendar(self, client: AsyncClient):
        with patch("src.work_calendar.router.list_shifts_by_calendar", new_callable=AsyncMock, return_value=[self._shift_response()]):
            resp = await client.get(f"/work-calendars/{CALENDAR_ID}/shifts")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_shift(self, client: AsyncClient):
        with patch("src.work_calendar.router.get_shift", new_callable=AsyncMock, return_value=self._shift_response()):
            resp = await client.get(f"/work-calendars/shifts/{SHIFT_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == SHIFT_ID

    @pytest.mark.asyncio
    async def test_update_shift(self, client: AsyncClient):
        updated = {**self._shift_response(), "name": "Morning Updated"}
        with patch("src.work_calendar.router.update_shift", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/work-calendars/shifts/{SHIFT_ID}", json={"name": "Morning Updated"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Morning Updated"

    @pytest.mark.asyncio
    async def test_delete_shift(self, client: AsyncClient):
        with patch("src.work_calendar.router.delete_shift", new_callable=AsyncMock):
            resp = await client.delete(f"/work-calendars/shifts/{SHIFT_ID}")
        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_working_day(self, client: AsyncClient):
        result = {
            "employee_id": EMPLOYEE_ID,
            "date": "2025-06-02",
            "is_working_day": True,
            "is_holiday": False,
            "is_weekend": False,
            "calendar_id": CALENDAR_ID,
            "reason": None,
        }
        with patch("src.work_calendar.router.is_working_day", new_callable=AsyncMock, return_value=result):
            resp = await client.get(
                f"/working-day?employee_id={EMPLOYEE_ID}&date=2025-06-02"
            )
        assert resp.status_code == 200
        assert resp.json()["is_working_day"] is True


# ── Leave Types ───────────────────────────────────────────────────────────────

class TestLeaveTypes:
    def _response(self) -> dict:
        return {
            "_id": TYPE_ID,
            "org_id": ORG_ID,
            "name": "Annual Leave",
            "code": "AL",
            "unit": "DAYS",
            "is_paid": True,
            "deduct_from_balance": True,
            "restrictions": {},
            "is_active": True,
            "show_description": False,
            "is_paid_leave": True,
            "deduct_from_leave_balance": True,
            "is_sick_leave": False,
            "is_statutory_leave": False,
            "description": None,
            "color": None,
            "is_custom": True,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_leave_type(self, client: AsyncClient):
        with patch("src.leave_types.router.create_leave_type", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/leave-types", json={
                "org_id": ORG_ID,
                "name": "Annual Leave",
                "code": "AL",
            })
        assert resp.status_code == 201
        assert resp.json()["id"] == TYPE_ID

    @pytest.mark.asyncio
    async def test_list_leave_types(self, client: AsyncClient):
        with patch("src.leave_types.router.list_leave_types", new_callable=AsyncMock, return_value=[self._response()]):
            resp = await client.get(f"/leave-types?org_id={ORG_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_leave_type(self, client: AsyncClient):
        with patch("src.leave_types.router.get_leave_type", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/leave-types/{TYPE_ID}")
        assert resp.status_code == 200
        assert resp.json()["code"] == "AL"

    @pytest.mark.asyncio
    async def test_update_leave_type(self, client: AsyncClient):
        updated = {**self._response(), "name": "Annual Leave Updated"}
        with patch("src.leave_types.router.update_leave_type", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/leave-types/{TYPE_ID}", json={"name": "Annual Leave Updated"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Annual Leave Updated"

    @pytest.mark.asyncio
    async def test_delete_leave_type(self, client: AsyncClient):
        with patch("src.leave_types.router.delete_leave_type", new_callable=AsyncMock):
            resp = await client.delete(f"/leave-types/{TYPE_ID}")
        assert resp.status_code == 204


# ── Leave Plans ───────────────────────────────────────────────────────────────

class TestLeavePlans:
    def _response(self) -> dict:
        return {
            "_id": PLAN_ID,
            "org_id": ORG_ID,
            "name": "Standard Leave Plan",
            "calendar_start_month": 1,
            "asset_id": None,
            "is_active": True,
            "progress": 1,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_leave_plan(self, client: AsyncClient):
        with patch("src.leave_plans.router.create_leave_plan", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/leave-plans", json={
                "org_id": ORG_ID,
                "name": "Standard Leave Plan",
            })
        assert resp.status_code == 201
        assert resp.json()["id"] == PLAN_ID

    @pytest.mark.asyncio
    async def test_list_leave_plans(self, client: AsyncClient):
        with patch("src.leave_plans.router.list_leave_plans", new_callable=AsyncMock, return_value=[self._response()]):
            resp = await client.get(f"/leave-plans?org_id={ORG_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_leave_plan(self, client: AsyncClient):
        with patch("src.leave_plans.router.get_leave_plan", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/leave-plans/{PLAN_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == PLAN_ID

    @pytest.mark.asyncio
    async def test_update_leave_plan(self, client: AsyncClient):
        updated = {**self._response(), "name": "Updated Plan"}
        with patch("src.leave_plans.router.update_leave_plan", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/leave-plans/{PLAN_ID}", json={"name": "Updated Plan"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Updated Plan"

    @pytest.mark.asyncio
    async def test_delete_leave_plan(self, client: AsyncClient):
        with patch("src.leave_plans.router.delete_leave_plan", new_callable=AsyncMock):
            resp = await client.delete(f"/leave-plans/{PLAN_ID}")
        assert resp.status_code == 204


# ── Leave Grant Policy ────────────────────────────────────────────────────────

class TestLeaveGrantPolicy:
    def _response(self) -> dict:
        return {
            "_id": GRANT_POLICY_ID,
            "org_id": ORG_ID,
            "leave_plan_id": PLAN_ID,
            "allocation": {"amount": 21, "unit": "DAYS", "frequency": "YEARLY"},
            "credited_year_usage": {"allow_anytime": True},
            "joining_rule": {
                "enabled": False,
                "first_month_restriction": {
                    "enabled": False,
                    "cutoff_day": 23,
                    "rule": "NO_CREDIT_IF_JOIN_AFTER",
                },
            },
            "extra_leave": {"enabled": False, "max_days": 0},
            "version": 1,
            "is_active": True,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_upsert_grant_policy(self, client: AsyncClient):
        with patch("src.leave_grant_policy.router.upsert_grant_policy", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post(f"/leave-plans/{PLAN_ID}/grant-policy", json={
                "allocation": {"amount": 21, "unit": "DAYS"},
            })
        assert resp.status_code == 200
        assert resp.json()["id"] == GRANT_POLICY_ID

    @pytest.mark.asyncio
    async def test_get_grant_policy(self, client: AsyncClient):
        with patch("src.leave_grant_policy.router.get_policy_by_plan", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/leave-plans/{PLAN_ID}/grant-policy")
        assert resp.status_code == 200
        assert resp.json()["allocation"]["amount"] == 21

    @pytest.mark.asyncio
    async def test_update_grant_policy(self, client: AsyncClient):
        updated = {**self._response(), "allocation": {"amount": 24, "unit": "DAYS", "frequency": "YEARLY"}}
        with patch("src.leave_grant_policy.router.update_grant_policy", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(
                f"/leave-plans/{PLAN_ID}/grant-policy/{GRANT_POLICY_ID}",
                json={"allocation": {"amount": 24, "unit": "DAYS"}},
            )
        assert resp.status_code == 200
        assert resp.json()["allocation"]["amount"] == 24


# ── Leave Plan Type Mapping ───────────────────────────────────────────────────

class TestLeavePlanTypeMapping:
    def _mapping_response(self) -> dict:
        return {
            "_id": "507f1f77bcf86cd799439031",
            "leave_plan_id": PLAN_ID,
            "leave_type_id": TYPE_ID,
            "org_id": ORG_ID,
            **_audit(),
        }

    def _detail_response(self) -> dict:
        return {
            "_id": "507f1f77bcf86cd799439031",
            "leave_plan_id": PLAN_ID,
            "org_id": ORG_ID,
            "leave_type": {
                "_id": TYPE_ID,
                "name": "Annual Leave",
                "description": None,
                "color": None,
                "unit": "DAYS",
                "is_custom": True,
            },
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_add_leave_type_to_plan(self, client: AsyncClient):
        with patch("src.leave_plan_type_mapping.router.add_leave_type_to_plan", new_callable=AsyncMock, return_value=self._mapping_response()):
            resp = await client.post(f"/leave-plans/{PLAN_ID}/leave-types", json={"leave_type_id": TYPE_ID})
        assert resp.status_code == 201
        assert resp.json()["leave_type_id"] == TYPE_ID

    @pytest.mark.asyncio
    async def test_list_leave_types_for_plan(self, client: AsyncClient):
        with patch("src.leave_plan_type_mapping.router.list_leave_types_for_plan", new_callable=AsyncMock, return_value=[self._detail_response()]):
            resp = await client.get(f"/leave-plans/{PLAN_ID}/leave-types")
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["leave_type"]["id"] == TYPE_ID

    @pytest.mark.asyncio
    async def test_remove_leave_type_from_plan(self, client: AsyncClient):
        with patch("src.leave_plan_type_mapping.router.remove_leave_type_from_plan", new_callable=AsyncMock):
            resp = await client.delete(f"/leave-plans/{PLAN_ID}/leave-types/{TYPE_ID}")
        assert resp.status_code == 204


# ── Leave Plan Assignments ────────────────────────────────────────────────────

class TestLeavePlanAssignments:
    def _assignment_response(self) -> dict:
        return {
            "_id": ASSIGNMENT_ID,
            "leave_plan_id": PLAN_ID,
            "scope_type": "ORG",
            "business_unit_id": None,
            "department_id": None,
            "priority": 1,
            "is_active": True,
            **_audit(),
        }

    def _employee_plan_response(self) -> dict:
        return {
            "_id": "507f1f77bcf86cd799439032",
            "employee_id": EMPLOYEE_ID,
            "leave_plan_id": PLAN_ID,
            "assignment_id": ASSIGNMENT_ID,
            "resolved_at": datetime(2025, 1, 1, tzinfo=timezone.utc),
        }

    @pytest.mark.asyncio
    async def test_create_assignment(self, client: AsyncClient):
        # create_assignment returns a LIST of assignment docs (one per resolved
        # scope) and the endpoint's response_model is a list — mock accordingly.
        with patch("src.leave_plan_assignments.router.create_assignment", new_callable=AsyncMock, return_value=[self._assignment_response()]):
            resp = await client.post("/leave-plan-assignments", json={
                "leave_plan_id": PLAN_ID,
                "scope_type": "ORG",
            })
        assert resp.status_code == 201
        assert resp.json()[0]["scope_type"] == "ORG"

    @pytest.mark.asyncio
    async def test_list_assignments(self, client: AsyncClient):
        with patch("src.leave_plan_assignments.router.list_assignments", new_callable=AsyncMock, return_value=[self._assignment_response()]):
            resp = await client.get(f"/leave-plans/{PLAN_ID}/assignments")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_resolve_employee_plan(self, client: AsyncClient):
        # The resolve endpoint takes ``user_id`` (the employee's user account) —
        # resolve_employee_plan has always been passed a user_id, the query param
        # was just misnamed employee_id.
        with patch("src.leave_plan_assignments.router.resolve_employee_plan", new_callable=AsyncMock, return_value=self._employee_plan_response()):
            resp = await client.post(
                f"/employee-leave-plans/resolve?user_id={EMPLOYEE_ID}&org_id={ORG_ID}"
            )
        assert resp.status_code == 200
        assert resp.json()["employee_id"] == EMPLOYEE_ID

    @pytest.mark.asyncio
    async def test_resolve_employee_plan_not_found(self, client: AsyncClient):
        with patch("src.leave_plan_assignments.router.resolve_employee_plan", new_callable=AsyncMock, return_value=None):
            resp = await client.post(
                f"/employee-leave-plans/resolve?user_id={EMPLOYEE_ID}&org_id={ORG_ID}"
            )
        assert resp.status_code == 200
        assert resp.json() is None

    @pytest.mark.skip(
        reason="GET /employee-leave-plans/{employee_id} is commented out in the "
               "router; re-enable this test if that endpoint comes back."
    )
    @pytest.mark.asyncio
    async def test_get_employee_leave_plan(self, client: AsyncClient):
        with patch("src.leave_plan_assignments.router.get_employee_leave_plan", new_callable=AsyncMock, return_value=self._employee_plan_response()):
            resp = await client.get(f"/employee-leave-plans/{EMPLOYEE_ID}")
        assert resp.status_code == 200
        assert resp.json()["leave_plan_id"] == PLAN_ID


# ── Entitlement Policies ──────────────────────────────────────────────────────

class TestEntitlementPolicies:
    def _response(self) -> dict:
        return {
            "_id": POLICY_ID,
            "leave_plan_id": PLAN_ID,
            "leave_type_id": TYPE_ID,
            "credit_strategy": "UPFRONT",
            "accrual_frequency": "NONE",
            "total_days": 21.0,
            "joining_policy": "FULL",
            "probation_policy": {"enabled": False, "type": "NONE", "fixed_days": None},
            "allow_future_request": False,
            "allow_negative_balance": False,
            "rounding_strategy": "EXACT",
            "expiry_policy": {
                "type": "NONE",
                "expiry_date": None,
                "days_after_credit": None,
                "carry_forward_enabled": False,
                "carry_forward_limit": None,
            },
            "min_leave_per_request": 0.5,
            "max_leave_per_request": None,
            "max_consecutive_days": None,
            "max_requests_per_period": None,
            "gap_between_requests_days": None,
            "allow_clubbing": False,
            "clubbable_leave_type_ids": [],
            "monthly_limit": None,
            "max_continuous_days": None,
            "allow_during_notice": True,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_entitlement_policy(self, client: AsyncClient):
        with patch("src.entitlement_policies.router.create_policy", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/entitlement-policies", json={
                "leave_plan_id": PLAN_ID,
                "leave_type_id": TYPE_ID,
                "total_days": 21,
            })
        assert resp.status_code == 201
        assert resp.json()["total_days"] == 21.0

    @pytest.mark.asyncio
    async def test_list_entitlement_policies(self, client: AsyncClient):
        with patch("src.entitlement_policies.router.list_policies", new_callable=AsyncMock, return_value=[self._response()]):
            resp = await client.get(f"/entitlement-policies?leave_plan_id={PLAN_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_entitlement_policy(self, client: AsyncClient):
        with patch("src.entitlement_policies.router.get_policy", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/entitlement-policies/{POLICY_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == POLICY_ID

    @pytest.mark.asyncio
    async def test_update_entitlement_policy(self, client: AsyncClient):
        updated = {**self._response(), "total_days": 25.0}
        with patch("src.entitlement_policies.router.update_policy", new_callable=AsyncMock, return_value=updated):
            resp = await client.put(f"/entitlement-policies/{POLICY_ID}", json={"total_days": 25})
        assert resp.status_code == 200
        assert resp.json()["total_days"] == 25.0


# ── Entitlements ──────────────────────────────────────────────────────────────

class TestEntitlements:
    def _entitlement_response(self) -> dict:
        return {
            "_id": ENTITLEMENT_ID,
            "employee_id": EMPLOYEE_ID,
            "leave_type_id": TYPE_ID,
            "policy_id": POLICY_ID,
            **_audit(),
        }

    def _ledger_response(self) -> dict:
        return {
            "_id": "507f1f77bcf86cd799439033",
            "employee_id": EMPLOYEE_ID,
            "leave_type_id": TYPE_ID,
            "transaction_type": "CREDIT",
            "amount": 21.0,
            "reference_id": None,
            "note": "Annual credit",
            "created_on": datetime(2025, 1, 1, tzinfo=timezone.utc),
            "created_by": "507f1f77bcf86cd799439012",
        }

    @pytest.mark.asyncio
    async def test_create_entitlement(self, client: AsyncClient):
        with patch("src.entitlements.router.create_entitlement", new_callable=AsyncMock, return_value=self._entitlement_response()):
            resp = await client.post("/entitlements", json={
                "employee_id": EMPLOYEE_ID,
                "leave_type_id": TYPE_ID,
                "policy_id": POLICY_ID,
            })
        assert resp.status_code == 201
        assert resp.json()["employee_id"] == EMPLOYEE_ID

    @pytest.mark.asyncio
    async def test_list_entitlements(self, client: AsyncClient):
        with patch("src.entitlements.router.get_entitlements_for_employee", new_callable=AsyncMock, return_value=[self._entitlement_response()]):
            resp = await client.get(f"/entitlements?employee_id={EMPLOYEE_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_add_ledger_entry_removed(self, client: AsyncClient):
        # The POST /entitlements/ledger route was removed (unused by the frontend);
        # only the GET read route remains, so a POST is now Method Not Allowed.
        resp = await client.post("/entitlements/ledger", json={
            "employee_id": EMPLOYEE_ID,
            "leave_type_id": TYPE_ID,
            "transaction_type": "CREDIT",
            "amount": 21.0,
            "note": "Annual credit",
        })
        assert resp.status_code == 405

    @pytest.mark.asyncio
    async def test_list_ledger_entries(self, client: AsyncClient):
        with patch("src.entitlements.router.get_ledger_entries", new_callable=AsyncMock, return_value=[self._ledger_response()]):
            resp = await client.get(f"/entitlements/ledger?employee_id={EMPLOYEE_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_balance(self, client: AsyncClient):
        result = {
            "employee_id": EMPLOYEE_ID,
            "leave_type_id": TYPE_ID,
            "total_credited": 21.0,
            "total_debited": 3.0,
            "balance": 18.0,
        }
        with patch("src.entitlements.router.compute_balance", new_callable=AsyncMock, return_value=result):
            resp = await client.get(
                f"/entitlements/balance?employee_id={EMPLOYEE_ID}&leave_type_id={TYPE_ID}"
            )
        assert resp.status_code == 200
        assert resp.json()["balance"] == 18.0


# ── Leave Requests ────────────────────────────────────────────────────────────

class TestApprovalFlows:
    def _response(self) -> dict:
        return {
            "_id": FLOW_ID,
            "leave_plan_id": PLAN_ID,
            "levels": [{"level": 1, "type": "ROLE", "value": "MANAGER"}],
            "skip_if_no_action_days": None,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_approval_flow(self, client: AsyncClient):
        with patch("src.leave_requests.router.create_approval_flow", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/approval-flows", json={
                "leave_plan_id": PLAN_ID,
                "levels": [{"level": 1, "type": "ROLE", "value": "MANAGER"}],
            })
        assert resp.status_code == 201
        assert resp.json()["leave_plan_id"] == PLAN_ID

    @pytest.mark.asyncio
    async def test_get_approval_flow(self, client: AsyncClient):
        with patch("src.leave_requests.router.get_approval_flow_by_plan", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/approval-flows?leave_plan_id={PLAN_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == FLOW_ID

    @pytest.mark.asyncio
    async def test_get_approval_flow_not_found(self, client: AsyncClient):
        with patch("src.leave_requests.router.get_approval_flow_by_plan", new_callable=AsyncMock, return_value=None):
            resp = await client.get(f"/approval-flows?leave_plan_id={PLAN_ID}")
        assert resp.status_code == 200
        assert resp.json() is None


class TestLeaveRequests:
    def _response(self) -> dict:
        return {
            "_id": REQUEST_ID,
            "employee_id": EMPLOYEE_ID,
            "leave_type_id": TYPE_ID,
            "leave_plan_id": PLAN_ID,
            "start_datetime": "2025-06-02T09:00:00+00:00",
            "end_datetime": "2025-06-03T18:00:00+00:00",
            "duration_hours": 16.0,
            "status": "PENDING",
            "approval_state": {"current_level": 1},
            "note": None,
            **_audit(),
        }

    @pytest.mark.asyncio
    async def test_create_leave_request(self, client: AsyncClient):
        with patch("src.leave_requests.router.create_leave_request", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.post("/leave-requests", json={
                "employee_id": EMPLOYEE_ID,
                "leave_type_id": TYPE_ID,
                "start_datetime": "2025-06-02T09:00:00Z",
                "end_datetime": "2025-06-03T18:00:00Z",
            })
        assert resp.status_code == 201
        assert resp.json()["status"] == "PENDING"

    @pytest.mark.asyncio
    async def test_list_leave_requests(self, client: AsyncClient):
        with patch("src.leave_requests.router.list_leave_requests", new_callable=AsyncMock, return_value=[self._response()]):
            resp = await client.get("/leave-requests")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_list_leave_requests_filtered(self, client: AsyncClient):
        with patch("src.leave_requests.router.list_leave_requests", new_callable=AsyncMock, return_value=[self._response()]):
            resp = await client.get(f"/leave-requests?employee_id={EMPLOYEE_ID}&status=PENDING")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_get_leave_request(self, client: AsyncClient):
        with patch("src.leave_requests.router.get_leave_request", new_callable=AsyncMock, return_value=self._response()):
            resp = await client.get(f"/leave-requests/{REQUEST_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == REQUEST_ID

    @pytest.mark.asyncio
    async def test_approve_leave_request(self, client: AsyncClient):
        approved = {**self._response(), "status": "APPROVED"}
        with patch("src.leave_requests.router.approve_leave_request", new_callable=AsyncMock, return_value=approved):
            resp = await client.post(f"/leave-requests/{REQUEST_ID}/approve", json={"comment": "Approved"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "APPROVED"

    @pytest.mark.asyncio
    async def test_reject_leave_request(self, client: AsyncClient):
        rejected = {**self._response(), "status": "REJECTED"}
        with patch("src.leave_requests.router.reject_leave_request", new_callable=AsyncMock, return_value=rejected):
            resp = await client.post(f"/leave-requests/{REQUEST_ID}/reject", json={"comment": "Not approved"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "REJECTED"

    @pytest.mark.asyncio
    async def test_cancel_leave_request(self, client: AsyncClient):
        cancelled = {**self._response(), "status": "CANCELLED"}
        with patch("src.leave_requests.router.cancel_leave_request", new_callable=AsyncMock, return_value=cancelled):
            resp = await client.post(f"/leave-requests/{REQUEST_ID}/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "CANCELLED"

    @pytest.mark.asyncio
    async def test_create_approval_override(self, client: AsyncClient):
        doc = {"_id": "507f1f77bcf86cd799439040", "leave_request_id": REQUEST_ID}
        with patch("src.leave_requests.router.create_approval_override", new_callable=AsyncMock, return_value=doc):
            resp = await client.post("/approval-overrides", json={
                "leave_request_id": REQUEST_ID,
                "levels": [{"level": 1, "approver_id": "507f1f77bcf86cd799439012"}],
            })
        assert resp.status_code == 201
        assert resp.json()["leave_request_id"] == REQUEST_ID
