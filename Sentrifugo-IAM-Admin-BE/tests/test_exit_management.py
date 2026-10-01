"""Tests for the Exit Management module — all 31 endpoints.

Covers happy paths and key error branches for:
  - Core exit request CRUD + withdraw / revoke / approve / reapply
  - Exit interview submit + get
  - Manager approve / reject
  - HR initiate clearances / deactivate / remind / list / summary
  - IT asset list / summary / verify
  - Admin task list / summary / complete
  - Finance request list / summary / status update
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from tests.conftest import TEST_USER_ID

BASE = "/exit-management"

TEST_ORG_ID = "507f1f77bcf86cd799439011"
TEST_EMP_ID = "507f1f77bcf86cd799439012"
TEST_REQUEST_ID = "507f1f77bcf86cd799439013"
TEST_ASSET_ID = "507f1f77bcf86cd799439014"
TEST_TASK_ID = "507f1f77bcf86cd799439015"
TEST_FINANCE_ID = "507f1f77bcf86cd799439016"

MOCK_USER = UserBase(
    id=TEST_USER_ID,
    email="testuser@example.com",
    first_name="Test",
    last_name="User",
    is_super_admin=True,
    is_org_admin=False,
    organisation_id=TEST_ORG_ID,
)

MOCK_EXIT_REQUEST = {
    "id": TEST_REQUEST_ID,
    "organisation_id": TEST_ORG_ID,
    "employee_id": TEST_EMP_ID,
    "request_code": "EXR-2026-0001",
    "last_working_day": "2026-07-31",
    "reason": "career_growth",
    "other_reason": None,
    "additional_details": None,
    "status": "pending_approval",
    "exit_type": "resignation",
    "hr_initiated": False,
    "immediate_exit": False,
    "deactivated_on": None,
    "deactivated_by": None,
    "rejection_reason": None,
    "approved_by": None,
    "approved_on": None,
    "requested_last_working_day": None,
    "parent_request_id": None,
    "document_ids": [],
    "created_on": "2026-05-18T10:00:00",
    "employee_name": "John Doe",
    "employee_email": "john@example.com",
    "emp_code": "EMP001",
}

MOCK_TEAM_REQUEST = {
    **MOCK_EXIT_REQUEST,
    "employee_role": "Software Engineer",
    "department": "Engineering",
    "date_of_joining": "2022-01-01",
    "current_location": "Desk 101",
    "reporting_manager_name": "Jane Smith",
    "notice_period_days": 30,
}

MOCK_HR_REQUEST = {
    **MOCK_TEAM_REQUEST,
    "sub_dept": None,
    "emp_type": "Permanent",
    "grade": None,
    "phone": "+91-9876543210",
}

MOCK_IT_ASSET = {
    "id": TEST_ASSET_ID,
    "organisation_id": TEST_ORG_ID,
    "exit_request_id": TEST_REQUEST_ID,
    "employee_id": TEST_EMP_ID,
    "asset_type": "laptop",
    "asset_id": "LAP-001",
    "serial_number": "SN123456",
    "model": "ThinkPad X1",
    "issued_date": "2023-01-15",
    "returned_date": None,
    "status": "pending",
    "condition": None,
    "verification_notes": None,
    "verified_by": None,
    "verified_on": None,
    "request_code": "EXR-2026-0001",
    "employee_name": "John Doe",
    "emp_code": "EMP001",
    "department": "Engineering",
    "last_working_day": "2026-07-31",
}

MOCK_ADMIN_TASK = {
    "id": TEST_TASK_ID,
    "organisation_id": TEST_ORG_ID,
    "exit_request_id": TEST_REQUEST_ID,
    "employee_id": TEST_EMP_ID,
    "task_type": "id_card_return",
    "details": "Return ID card",
    "desk_number": None,
    "locker_number": None,
    "issued_date": None,
    "submitted_date": None,
    "status": "pending",
    "completed_checklist": [],
    "notes": None,
    "completed_by": None,
    "completed_on": None,
    "request_code": "EXR-2026-0001",
    "employee_name": "John Doe",
    "emp_code": "EMP001",
    "department": "Engineering",
    "last_working_day": "2026-07-31",
}

MOCK_FINANCE = {
    "id": TEST_FINANCE_ID,
    "organisation_id": TEST_ORG_ID,
    "exit_request_id": TEST_REQUEST_ID,
    "employee_id": TEST_EMP_ID,
    "amount_due": 0.0,
    "settlement_date": None,
    "notice_period_days": 30,
    "status": "pending",
    "clearance_reason": None,
    "remarks": None,
    "cleared_by": None,
    "cleared_on": None,
    "request_code": "EXR-2026-0001",
    "employee_name": "John Doe",
    "emp_code": "EMP001",
    "department": "Engineering",
    "designation": "Software Engineer",
    "reporting_manager_name": "Jane Smith",
    "last_working_day": "2026-07-31",
}

MOCK_INTERVIEW = {
    "id": "507f1f77bcf86cd799439017",
    "exit_request_id": TEST_REQUEST_ID,
    "employee_id": TEST_EMP_ID,
    "reason_for_leaving": "Better opportunity",
    "other_reason": None,
    "overall_rating": 4.0,
    "liked_most": "Team culture",
    "improvements": None,
    "manager_feedback": None,
    "created_on": "2026-05-18T10:00:00",
}


def _auth_patch():
    """Context manager that mocks get_user_by_email for auth cold path."""
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=MOCK_USER,
    )


# ---------------------------------------------------------------------------
# Core Exit Request CRUD
# ---------------------------------------------------------------------------
class TestCreateExitRequest:
    @pytest.mark.asyncio
    async def test_create_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.create_exit_request",
                   new_callable=AsyncMock, return_value=MOCK_EXIT_REQUEST):
            resp = await client.post(
                f"{BASE}/requests",
                json={
                    "employeeId": TEST_EMP_ID,
                    "lastWorkingDay": "2026-07-31",
                    "reason": "career_growth",
                    "exitType": "resignation",
                },
                headers=auth_headers,
            )
        assert resp.status_code == 201
        assert resp.json()["requestCode"] == "EXR-2026-0001"

    @pytest.mark.asyncio
    async def test_create_employee_not_found(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.create_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=404, detail="Employee not found")):
            resp = await client.post(
                f"{BASE}/requests",
                json={
                    "employeeId": TEST_EMP_ID,
                    "lastWorkingDay": "2026-07-31",
                    "reason": "career_growth",
                },
                headers=auth_headers,
            )
        assert resp.status_code == 404


class TestListExitRequests:
    @pytest.mark.asyncio
    async def test_list_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_exit_requests",
                   new_callable=AsyncMock, return_value=[MOCK_EXIT_REQUEST]):
            resp = await client.get(f"{BASE}/requests", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_list_with_status_filter(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_exit_requests",
                   new_callable=AsyncMock, return_value=[]) as mock_svc:
            resp = await client.get(
                f"{BASE}/requests?status=approved", headers=auth_headers
            )
        assert resp.status_code == 200
        mock_svc.assert_awaited_once()


class TestGetExitRequest:
    @pytest.mark.asyncio
    async def test_get_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_exit_request",
                   new_callable=AsyncMock, return_value=MOCK_EXIT_REQUEST):
            resp = await client.get(f"{BASE}/requests/{TEST_REQUEST_ID}", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["empCode"] == "EMP001"

    @pytest.mark.asyncio
    async def test_get_not_found(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=404, detail="Exit request not found")):
            resp = await client.get(f"{BASE}/requests/{TEST_REQUEST_ID}", headers=auth_headers)
        assert resp.status_code == 404


class TestUpdateExitRequest:
    @pytest.mark.asyncio
    async def test_update_success(self, client: AsyncClient, auth_headers):
        updated = {**MOCK_EXIT_REQUEST, "last_working_day": "2026-08-15"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.update_exit_request",
                   new_callable=AsyncMock, return_value=updated):
            resp = await client.put(
                f"{BASE}/requests/{TEST_REQUEST_ID}",
                json={"lastWorkingDay": "2026-08-15"},
                headers=auth_headers,
            )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_update_not_pending_rejected(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.update_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Only pending requests can be updated")):
            resp = await client.put(
                f"{BASE}/requests/{TEST_REQUEST_ID}",
                json={"lastWorkingDay": "2026-08-15"},
                headers=auth_headers,
            )
        assert resp.status_code == 400


class TestWithdrawRevokeRequest:
    @pytest.mark.asyncio
    async def test_withdraw_success(self, client: AsyncClient, auth_headers):
        withdrawn = {**MOCK_EXIT_REQUEST, "status": "withdrawn"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.withdraw_exit_request",
                   new_callable=AsyncMock, return_value=withdrawn):
            resp = await client.put(
                f"{BASE}/requests/{TEST_REQUEST_ID}/withdraw", headers=auth_headers
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "withdrawn"

    @pytest.mark.asyncio
    async def test_withdraw_invalid_status(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.withdraw_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Only pending, approved, or awaiting clearance requests can be withdrawn")):
            resp = await client.put(
                f"{BASE}/requests/{TEST_REQUEST_ID}/withdraw", headers=auth_headers
            )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_revoke_success(self, client: AsyncClient, auth_headers):
        revoked = {**MOCK_EXIT_REQUEST, "status": "withdrawn"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.revoke_exit_request",
                   new_callable=AsyncMock, return_value=revoked):
            resp = await client.put(
                f"{BASE}/requests/{TEST_REQUEST_ID}/revoke", headers=auth_headers
            )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_revoke_invalid_status(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.revoke_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Only approved or awaiting clearance requests can be revoked")):
            resp = await client.put(
                f"{BASE}/requests/{TEST_REQUEST_ID}/revoke", headers=auth_headers
            )
        assert resp.status_code == 400


class TestApproveExitRequest:
    @pytest.mark.asyncio
    async def test_approve_success(self, client: AsyncClient, auth_headers):
        approved = {**MOCK_EXIT_REQUEST, "status": "approved"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.approve_exit_request",
                   new_callable=AsyncMock, return_value=approved):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/approve",
                json={"status": "approved"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

    @pytest.mark.asyncio
    async def test_reject_without_reason_fails(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.approve_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Rejection reason is required")):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/approve",
                json={"status": "rejected"},
                headers=auth_headers,
            )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_reject_with_reason_success(self, client: AsyncClient, auth_headers):
        rejected = {**MOCK_EXIT_REQUEST, "status": "rejected", "rejection_reason": "Not approved"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.approve_exit_request",
                   new_callable=AsyncMock, return_value=rejected):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/approve",
                json={"status": "rejected", "rejectionReason": "Not approved"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"


class TestReapplyExitRequest:
    @pytest.mark.asyncio
    async def test_reapply_success(self, client: AsyncClient, auth_headers):
        reapplied = {**MOCK_EXIT_REQUEST, "parent_request_id": TEST_REQUEST_ID}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.reapply_exit_request",
                   new_callable=AsyncMock, return_value=reapplied):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/reapply",
                json={
                    "employeeId": TEST_EMP_ID,
                    "lastWorkingDay": "2026-08-31",
                    "reason": "career_growth",
                },
                headers=auth_headers,
            )
        assert resp.status_code == 201

    @pytest.mark.asyncio
    async def test_reapply_not_rejected_fails(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.reapply_exit_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Can only reapply for rejected requests")):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/reapply",
                json={
                    "employeeId": TEST_EMP_ID,
                    "lastWorkingDay": "2026-08-31",
                    "reason": "career_growth",
                },
                headers=auth_headers,
            )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Exit Interview
# ---------------------------------------------------------------------------
class TestExitInterview:
    @pytest.mark.asyncio
    async def test_submit_interview_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.submit_exit_interview",
                   new_callable=AsyncMock, return_value=MOCK_INTERVIEW):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/interview",
                json={
                    "reasonForLeaving": "Better opportunity",
                    "overallRating": 4.0,
                    "likedMost": "Team culture",
                },
                headers=auth_headers,
            )
        assert resp.status_code == 201
        assert resp.json()["overallRating"] == 4.0

    @pytest.mark.asyncio
    async def test_submit_interview_duplicate_fails(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.submit_exit_interview",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Exit interview already submitted")):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/interview",
                json={"overallRating": 3.5},
                headers=auth_headers,
            )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_get_interview_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_exit_interview",
                   new_callable=AsyncMock, return_value=MOCK_INTERVIEW):
            resp = await client.get(
                f"{BASE}/requests/{TEST_REQUEST_ID}/interview", headers=auth_headers
            )
        assert resp.status_code == 200
        assert resp.json()["exitRequestId"] == TEST_REQUEST_ID

    @pytest.mark.asyncio
    async def test_get_interview_not_found(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_exit_interview",
                   new_callable=AsyncMock, return_value=None):
            resp = await client.get(
                f"{BASE}/requests/{TEST_REQUEST_ID}/interview", headers=auth_headers
            )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Manager Flow
# ---------------------------------------------------------------------------
class TestManagerFlow:
    @pytest.mark.asyncio
    async def test_list_team_requests(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_team_exit_requests",
                   new_callable=AsyncMock, return_value=[MOCK_TEAM_REQUEST]):
            resp = await client.get(f"{BASE}/team-requests", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_get_team_summary(self, client: AsyncClient, auth_headers):
        summary = {
            "total": 5,
            "pending_approval": 2,
            "under_review": 1,
            "approved": 1,
            "rejected": 0,
            "withdrawn": 1,
        }
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_team_exit_summary",
                   new_callable=AsyncMock, return_value=summary):
            resp = await client.get(f"{BASE}/team-requests/summary", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 5

    @pytest.mark.asyncio
    async def test_manager_approve_success(self, client: AsyncClient, auth_headers):
        approved = {**MOCK_TEAM_REQUEST, "status": "approved"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.manager_approve_request",
                   new_callable=AsyncMock, return_value=approved):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/manager-approve",
                json={"finalLastWorkingDay": "2026-07-31", "comments": "Approved"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

    @pytest.mark.asyncio
    async def test_manager_reject_standard(self, client: AsyncClient, auth_headers):
        rejected = {**MOCK_TEAM_REQUEST, "status": "rejected"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.manager_reject_request",
                   new_callable=AsyncMock, return_value=rejected):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/manager-reject",
                json={"actionType": "standard", "comments": "Not suitable time"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"

    @pytest.mark.asyncio
    async def test_manager_reject_invalid_action_type(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.manager_reject_request",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Action type must be 'standard' or 'retention'")):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/manager-reject",
                json={"actionType": "unknown", "comments": "Nope"},
                headers=auth_headers,
            )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# HR Flow
# ---------------------------------------------------------------------------
class TestHRFlow:
    @pytest.mark.asyncio
    async def test_initiate_clearances_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.initiate_clearances",
                   new_callable=AsyncMock,
                   return_value={"status": "success", "message": "Clearances initiated successfully"}):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/initiate-clearances", headers=auth_headers
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"

    @pytest.mark.asyncio
    async def test_initiate_clearances_not_approved(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.initiate_clearances",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=400, detail="Only approved requests can have clearances initiated")):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/initiate-clearances", headers=auth_headers
            )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_deactivate_employee_success(self, client: AsyncClient, auth_headers):
        deactivated = {**MOCK_EXIT_REQUEST, "status": "deactivated"}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.deactivate_employee",
                   new_callable=AsyncMock, return_value=deactivated):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/deactivate", headers=auth_headers
            )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_send_clearance_reminder(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.send_clearance_reminder",
                   new_callable=AsyncMock,
                   return_value={"status": "success", "message": "Reminder sent successfully"}):
            resp = await client.post(
                f"{BASE}/requests/{TEST_REQUEST_ID}/remind", headers=auth_headers
            )
        assert resp.status_code == 200
        assert resp.json()["message"] == "Reminder sent successfully"

    @pytest.mark.asyncio
    async def test_list_hr_requests(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_hr_exit_requests",
                   new_callable=AsyncMock, return_value=[MOCK_HR_REQUEST]):
            resp = await client.get(f"{BASE}/hr-requests", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_list_hr_requests_with_filters(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_hr_exit_requests",
                   new_callable=AsyncMock, return_value=[]) as mock_svc:
            resp = await client.get(
                f"{BASE}/hr-requests?status=approved&department=Engineering&fromDate=2026-01-01&toDate=2026-12-31",
                headers=auth_headers,
            )
        assert resp.status_code == 200
        mock_svc.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_get_hr_summary(self, client: AsyncClient, auth_headers):
        summary = {
            "total": 10,
            "in_progress": 3,
            "pending_tasks": 0,
            "awaiting_clearances": 4,
            "completed": 3,
        }
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_hr_exit_summary",
                   new_callable=AsyncMock, return_value=summary):
            resp = await client.get(f"{BASE}/hr-requests/summary", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 10
        assert resp.json()["awaitingClearances"] == 4


# ---------------------------------------------------------------------------
# IT Asset Flow
# ---------------------------------------------------------------------------
class TestITAssetFlow:
    @pytest.mark.asyncio
    async def test_list_it_assets(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_it_assets",
                   new_callable=AsyncMock, return_value=[MOCK_IT_ASSET]):
            resp = await client.get(f"{BASE}/it/assets", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["assetType"] == "laptop"

    @pytest.mark.asyncio
    async def test_list_it_assets_with_filters(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_it_assets",
                   new_callable=AsyncMock, return_value=[]) as mock_svc:
            resp = await client.get(
                f"{BASE}/it/assets?status=pending&assetType=laptop", headers=auth_headers
            )
        assert resp.status_code == 200
        mock_svc.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_get_it_assets_summary(self, client: AsyncClient, auth_headers):
        summary = {"total": 5, "pending": 3, "returned": 1, "verified": 1}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_it_assets_summary",
                   new_callable=AsyncMock, return_value=summary):
            resp = await client.get(f"{BASE}/it/assets/summary", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 5

    @pytest.mark.asyncio
    async def test_verify_it_asset_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.verify_it_asset",
                   new_callable=AsyncMock,
                   return_value={"status": "success", "message": "Asset verified"}):
            resp = await client.post(
                f"{BASE}/it/assets/{TEST_ASSET_ID}/verify",
                json={"condition": "good", "verificationNotes": "No damage"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"

    @pytest.mark.asyncio
    async def test_verify_it_asset_not_found(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.verify_it_asset",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=404, detail="Asset return not found")):
            resp = await client.post(
                f"{BASE}/it/assets/{TEST_ASSET_ID}/verify",
                json={"condition": "good", "verificationNotes": "OK"},
                headers=auth_headers,
            )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Admin Task Flow
# ---------------------------------------------------------------------------
class TestAdminTaskFlow:
    @pytest.mark.asyncio
    async def test_list_admin_tasks(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_admin_tasks",
                   new_callable=AsyncMock, return_value=[MOCK_ADMIN_TASK]):
            resp = await client.get(f"{BASE}/admin/tasks", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["taskType"] == "id_card_return"

    @pytest.mark.asyncio
    async def test_list_admin_tasks_with_filters(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_admin_tasks",
                   new_callable=AsyncMock, return_value=[]) as mock_svc:
            resp = await client.get(
                f"{BASE}/admin/tasks?status=pending&taskType=id_card_return",
                headers=auth_headers,
            )
        assert resp.status_code == 200
        mock_svc.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_get_admin_tasks_summary(self, client: AsyncClient, auth_headers):
        summary = {"total": 4, "pending": 2, "returned": 1, "completed": 1}
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_admin_tasks_summary",
                   new_callable=AsyncMock, return_value=summary):
            resp = await client.get(f"{BASE}/admin/tasks/summary", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 4

    @pytest.mark.asyncio
    async def test_complete_admin_task_success(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.complete_admin_task",
                   new_callable=AsyncMock,
                   return_value={"status": "success", "message": "Task completed"}):
            resp = await client.post(
                f"{BASE}/admin/tasks/{TEST_TASK_ID}/complete",
                json={
                    "completedChecklist": ["id_card", "access_card"],
                    "notes": "All items collected",
                },
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"

    @pytest.mark.asyncio
    async def test_complete_admin_task_not_found(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.complete_admin_task",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=404, detail="Task not found")):
            resp = await client.post(
                f"{BASE}/admin/tasks/{TEST_TASK_ID}/complete",
                json={"completedChecklist": [], "notes": "Done"},
                headers=auth_headers,
            )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Finance Flow
# ---------------------------------------------------------------------------
class TestFinanceFlow:
    @pytest.mark.asyncio
    async def test_list_finance_requests(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_finance_requests",
                   new_callable=AsyncMock, return_value=[MOCK_FINANCE]):
            resp = await client.get(f"{BASE}/finance/requests", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_list_finance_requests_with_filters(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.list_finance_requests",
                   new_callable=AsyncMock, return_value=[]) as mock_svc:
            resp = await client.get(
                f"{BASE}/finance/requests?status=approved&fromDate=2026-01-01&toDate=2026-12-31",
                headers=auth_headers,
            )
        assert resp.status_code == 200
        mock_svc.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_get_finance_summary(self, client: AsyncClient, auth_headers):
        summary = {
            "total": 8,
            "pending": 3,
            "under_review": 2,
            "approved": 1,
            "sent_to_payroll": 1,
            "paid": 1,
            "not_cleared": 0,
        }
        with _auth_patch(), \
             patch("src.modules.exit_management.service.get_finance_summary",
                   new_callable=AsyncMock, return_value=summary):
            resp = await client.get(f"{BASE}/finance/requests/summary", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["total"] == 8
        assert resp.json()["sentToPayroll"] == 1

    @pytest.mark.asyncio
    async def test_update_finance_status_approved(self, client: AsyncClient, auth_headers):
        with _auth_patch(), \
             patch("src.modules.exit_management.service.update_finance_status",
                   new_callable=AsyncMock,
                   return_value={"status": "success", "message": "Clearance status updated"}):
            resp = await client.post(
                f"{BASE}/finance/requests/{TEST_FINANCE_ID}/status",
                json={"status": "approved", "remarks": "Cleared"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"

    @pytest.mark.asyncio
    async def test_update_finance_status_not_cleared_requires_reason(
        self, client: AsyncClient, auth_headers
    ):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.update_finance_status",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(
                       status_code=400, detail="Reason and remarks required when not cleared"
                   )):
            resp = await client.post(
                f"{BASE}/finance/requests/{TEST_FINANCE_ID}/status",
                json={"status": "not_cleared"},
                headers=auth_headers,
            )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_update_finance_status_not_found(self, client: AsyncClient, auth_headers):
        from fastapi import HTTPException
        with _auth_patch(), \
             patch("src.modules.exit_management.service.update_finance_status",
                   new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=404, detail="Clearance request not found")):
            resp = await client.post(
                f"{BASE}/finance/requests/{TEST_FINANCE_ID}/status",
                json={"status": "approved"},
                headers=auth_headers,
            )
        assert resp.status_code == 404
