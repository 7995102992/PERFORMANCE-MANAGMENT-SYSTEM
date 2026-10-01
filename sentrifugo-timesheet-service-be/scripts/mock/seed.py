"""
Seed script for sentrifugo-timesheet-be.

Clears ALL timesheet data and repopulates with realistic data to test
the full employee timesheet workflow end-to-end:

  Config:  Settings, approval levels
  Admin:   Clients, projects, tasks, project-task links, resource assignments
  Employee: Timesheets in every status so you can test submit, resubmit, view
  Manager:  Approval records so history is visible

Usage:
    cd sentrifugo-timesheet-be
    .venv/Scripts/python seed.py
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from beanie import init_beanie

from src.config import settings
from src.models import (
    ALL_DOCUMENTS,
    Client,
    Project,
    ProjectTask,
    ResourceAssignment,
    WeeklyTimesheet,
    TimesheetEntry,
    ApprovalRecord,
    TimesheetSettings,
    ApprovalLevelConfig,
    ProjectTypeEnum,
    ProjectStatusEnum,
    TimesheetStatusEnum,
    ApprovalActionEnum,
    ApproverRoleEnum,
    StatusEnum,
    Task,
)

# ──────────────────────────────────────────────────────────────
# IAM user IDs  (from MongoDB users collection)
# ──────────────────────────────────────────────────────────────
ORG_ID = "69fdb48a7b3e3279cee669f7"

EMPLOYEE_ID = "69fdc958e881fd8051db576b"    # employeeuser7477@yopmail.com
MANAGER_ID  = "69fdc8c6dd6d8ccb9072dc06"    # manager8462@yopmail.com
ADMIN_ID    = "69fdb48a7b3e3279cee669f8"    # admin8462@yopmail.com

NOW = datetime.now(timezone.utc)


def monday_of(weeks_ago: int = 0) -> datetime:
    today = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    return today - timedelta(days=today.weekday()) - timedelta(weeks=weeks_ago)


def sunday_of(monday: datetime) -> datetime:
    return monday + timedelta(days=6, hours=23, minutes=59, seconds=59)


# ──────────────────────────────────────────────────────────────
async def seed():
    motor = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    db = motor[settings.MONGO_DB_NAME]
    print(f"Connected to {settings.MONGO_DB_NAME}")

    # ─── CLEAR (before init_beanie so old indexes don't conflict) ──
    print("\n[0] Dropping all collections + stale indexes...")
    for name in await db.list_collection_names():
        await db[name].drop()
    print("  Done.")

    await init_beanie(database=db, document_models=ALL_DOCUMENTS)

    # ─── 1. CLIENTS ───────────────────────────────────────────
    print("\n[1] Clients...")
    c1 = Client(
        organisation_id=ORG_ID, name="Acme Corp", name_lc="acme corp",
        contact_person="Bob Smith", contact_email="bob@acmecorp.com",
        contact_phone="+1-555-0101", country="US", state="California",
        portal_access_enabled=True,
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    c2 = Client(
        organisation_id=ORG_ID, name="Globex Inc", name_lc="globex inc",
        contact_person="Carol White", contact_email="carol@globex.com",
        contact_phone="+1-555-0202", country="US", state="New York",
        portal_access_enabled=True,
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    await c1.insert()
    await c2.insert()
    print(f"  {c1.name}, {c2.name}")

    # ─── 2. PROJECTS ─────────────────────────────────────────
    print("\n[2] Projects...")
    p1 = Project(
        organisation_id=ORG_ID, client_id=str(c1.id),
        name="Website Redesign", name_lc="website redesign", code="WEB-001",
        description="Corporate website overhaul",
        project_type=ProjectTypeEnum.TIME_AND_MATERIALS,
        project_status=ProjectStatusEnum.ACTIVE,
        start_date=NOW - timedelta(days=90), budget_hours=500, hourly_rate=150.0, currency="USD",
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    p2 = Project(
        organisation_id=ORG_ID, client_id=str(c2.id),
        name="Mobile App", name_lc="mobile app", code="MOB-001",
        description="Cross-platform mobile application",
        project_type=ProjectTypeEnum.FIXED_FEE,
        project_status=ProjectStatusEnum.ACTIVE,
        start_date=NOW - timedelta(days=60), budget_hours=800, hourly_rate=175.0, currency="USD",
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    p3 = Project(
        organisation_id=ORG_ID, client_id=str(c1.id),
        name="API Backend", name_lc="api backend", code="API-001",
        description="REST API services",
        project_type=ProjectTypeEnum.TIME_AND_MATERIALS,
        project_status=ProjectStatusEnum.ACTIVE,
        start_date=NOW - timedelta(days=30), budget_hours=300, hourly_rate=160.0, currency="USD",
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    for p in [p1, p2, p3]:
        await p.insert()
    print(f"  {p1.name}, {p2.name}, {p3.name}")

    # ─── 3. TASKS ────────────────────────────────────────────
    print("\n[3] Tasks...")
    task_defs = [
        ("Frontend Development", True),
        ("Backend API", True),
        ("UI Design", True),
        ("Testing & QA", False),
        ("Documentation", False),
        ("Code Review", True),
        ("Meetings", False),
    ]
    tasks = []
    for name, billable in task_defs:
        t = Task(
            organisation_id=ORG_ID, name=name, name_lc=name.lower(),
            is_global=True, is_billable=billable,
            created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
        )
        await t.insert()
        tasks.append(t)
    T = {t.name: str(t.id) for t in tasks}
    print(f"  {len(tasks)} tasks: {', '.join(T.keys())}")

    # ─── 4. PROJECT-TASK LINKS ───────────────────────────────
    print("\n[4] Project-task assignments...")
    pt_links = [
        # Website: Frontend, UI Design, Testing, Code Review, Meetings
        (p1, ["Frontend Development", "UI Design", "Testing & QA", "Code Review", "Meetings"]),
        # Mobile: Frontend, Backend, UI Design, Testing, Code Review
        (p2, ["Frontend Development", "Backend API", "UI Design", "Testing & QA", "Code Review"]),
        # API: Backend, Documentation, Testing, Code Review, Meetings
        (p3, ["Backend API", "Documentation", "Testing & QA", "Code Review", "Meetings"]),
    ]
    pt_docs = []
    for proj, task_names in pt_links:
        for tn in task_names:
            pt_docs.append(ProjectTask(
                organisation_id=ORG_ID, project_id=str(proj.id), task_id=T[tn],
                estimated_hours=100, billable_rate=150.0,
                created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
            ))
    await ProjectTask.insert_many(pt_docs)
    print(f"  {len(pt_docs)} links")

    # ─── 5. RESOURCE ASSIGNMENTS ─────────────────────────────
    print("\n[5] Resource assignments...")
    ra_docs = []
    for proj in [p1, p2, p3]:
        ra_docs.append(ResourceAssignment(
            organisation_id=ORG_ID, project_id=str(proj.id), user_id=EMPLOYEE_ID,
            role="developer", allocation_percentage=50, is_billable=True,
            start_date=proj.start_date,
            created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
        ))
        ra_docs.append(ResourceAssignment(
            organisation_id=ORG_ID, project_id=str(proj.id), user_id=MANAGER_ID,
            role="manager", allocation_percentage=10, is_billable=False,
            start_date=proj.start_date,
            created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
        ))
    await ResourceAssignment.insert_many(ra_docs)
    print(f"  Employee + Manager on all 3 projects ({len(ra_docs)} rows)")

    # ─── 6. TIMESHEET SETTINGS ───────────────────────────────
    print("\n[6] Timesheet settings...")
    ts_settings = TimesheetSettings(
        organisation_id=ORG_ID,
        # Hours
        daily_restrictions_enabled=True,
        min_hours_per_day=0,
        max_hours_per_day=12,
        weekly_restrictions_enabled=True,
        standard_hours_per_day=8,
        max_hours_per_week=50,
        show_hours_type="gross",
        # Submission
        allow_past_due_submission=True,
        submission_compliance_type="weekly",
        submission_deadline_hours=0,
        submission_day="friday",
        submission_time="18:00",
        allow_attachment=True,
        # Approval
        approval_required=True,
        allow_future_entries=False,
        allow_past_entries_days=90,
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    await ts_settings.insert()

    al1 = ApprovalLevelConfig(
        organisation_id=ORG_ID, settings_id=str(ts_settings.id),
        level=1, approver_role="manager",
        created_by=ADMIN_ID, created_on=NOW, modified_by=ADMIN_ID, modified_on=NOW,
    )
    await al1.insert()
    print("  Settings + L1 approval level (manager)")

    # ─── 7. TIMESHEETS & ENTRIES ─────────────────────────────
    print("\n[7] Timesheets for employee...")

    W = str(p1.id)   # Website
    M = str(p2.id)   # Mobile
    A = str(p3.id)   # API

    async def make_ts(
        weeks_ago: int,
        status: TimesheetStatusEnum,
        rows: list[tuple[str, str, list[float]]],
    ) -> WeeklyTimesheet:
        mon = monday_of(weeks_ago)
        ts = WeeklyTimesheet(
            organisation_id=ORG_ID, user_id=EMPLOYEE_ID,
            week_start_date=mon, week_end_date=sunday_of(mon),
            timesheet_status=status,
            submitted_at=NOW if status != TimesheetStatusEnum.DRAFT else None,
            created_by=EMPLOYEE_ID, created_on=NOW, modified_by=EMPLOYEE_ID, modified_on=NOW,
        )
        await ts.insert()

        total = bill = nonbill = 0.0
        entries = []
        for proj_id, task_id, daily in rows:
            task_obj = next((t for t in tasks if str(t.id) == task_id), None)
            billable = task_obj.is_billable if task_obj else True
            for i, h in enumerate(daily):
                if h > 0:
                    entries.append(TimesheetEntry(
                        organisation_id=ORG_ID, weekly_timesheet_id=str(ts.id),
                        project_id=proj_id, task_id=task_id,
                        entry_date=mon + timedelta(days=i), hours=h, is_billable=billable,
                        notes=None,
                        created_by=EMPLOYEE_ID, created_on=NOW, modified_by=EMPLOYEE_ID, modified_on=NOW,
                    ))
                    total += h
                    if billable:
                        bill += h
                    else:
                        nonbill += h
        if entries:
            await TimesheetEntry.insert_many(entries)
        ts.total_hours = total
        ts.billable_hours = bill
        ts.non_billable_hours = nonbill
        await ts.save()
        return ts

    #                                                     Mon Tue Wed Thu Fri Sat Sun
    # ── Week -7: FINAL APPROVED (client_approved) ──────────────────────────
    ts7 = await make_ts(7, TimesheetStatusEnum.CLIENT_APPROVED, [
        (W, T["Frontend Development"], [8, 8, 8, 8, 8, 0, 0]),
    ])
    print(f"  -7w  client_approved  40h  {ts7.id}")

    # ── Week -6: RESUBMITTED (was rejected, employee fixed & resubmitted) ──
    ts6 = await make_ts(6, TimesheetStatusEnum.RESUBMITTED, [
        (W, T["UI Design"],             [4, 4, 4, 4, 4, 0, 0]),
        (M, T["Frontend Development"],  [4, 4, 4, 4, 4, 0, 0]),
    ])
    print(f"  -6w  resubmitted     40h  {ts6.id}")

    # ── Week -5: CLIENT REJECTED (L1 approved then client bounced it) ──
    ts5 = await make_ts(5, TimesheetStatusEnum.CLIENT_REJECTED, [
        (A, T["Backend API"], [8, 8, 8, 8, 8, 0, 0]),
    ])
    print(f"  -5w  client_rejected 40h  {ts5.id}")

    # ── Week -4: L1 APPROVED (manager approved, awaiting client if needed) ──
    ts4 = await make_ts(4, TimesheetStatusEnum.L1_APPROVED, [
        (W, T["Frontend Development"], [5, 5, 4, 5, 5, 0, 0]),
        (M, T["UI Design"],           [3, 3, 4, 3, 3, 0, 0]),
    ])
    print(f"  -4w  l1_approved     40h  {ts4.id}")

    # ── Week -3: SUBMITTED (waiting for manager to review) ──
    ts3 = await make_ts(3, TimesheetStatusEnum.SUBMITTED, [
        (M, T["Backend API"],          [6, 7, 6, 7, 6, 0, 0]),
        (A, T["Backend API"],          [2, 1, 2, 1, 2, 0, 0]),
    ])
    print(f"  -3w  submitted       40h  {ts3.id}")

    # ── Week -2: L1 REJECTED (manager rejected, employee must fix) ──
    ts2 = await make_ts(2, TimesheetStatusEnum.L1_REJECTED, [
        (W, T["Frontend Development"], [4, 4, 4, 4, 4, 0, 0]),
        (M, T["UI Design"],           [2, 2, 2, 2, 2, 0, 0]),
        (A, T["Documentation"],        [2, 2, 2, 2, 2, 0, 0]),
    ])
    print(f"  -2w  l1_rejected     40h  {ts2.id}")

    # ── Week -1: DRAFT with partial hours (employee can complete + submit) ──
    ts1 = await make_ts(1, TimesheetStatusEnum.DRAFT, [
        (W, T["Frontend Development"], [8, 8, 7, 8, 0, 0, 0]),
        (M, T["Code Review"],          [0, 0, 1, 0, 0, 0, 0]),
        (A, T["Meetings"],             [0, 0, 0, 0, 1, 0, 0]),
    ])
    print(f"  -1w  draft (partial) 33h  {ts1.id}")

    # ── Current week: NO TIMESHEET (employee creates fresh) ──
    print(f"   0w  <none> -- employee creates this via UI")

    # ─── 8. APPROVAL RECORDS ─────────────────────────────────
    print("\n[8] Approval records...")
    approvals = [
        # ts7 (week -7): manager approved -> client approved
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts7.id),
            approver_id=MANAGER_ID, approver_role=ApproverRoleEnum.MANAGER,
            approval_level=1, action=ApprovalActionEnum.APPROVED,
            comments="Good work.", acted_at=NOW - timedelta(days=46),
            created_by=MANAGER_ID, created_on=NOW, modified_by=MANAGER_ID, modified_on=NOW,
        ),
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts7.id),
            approver_id="client_user_001", approver_role=ApproverRoleEnum.CLIENT,
            approval_level=2, action=ApprovalActionEnum.APPROVED,
            comments="All good.", acted_at=NOW - timedelta(days=45),
            created_by="client_user_001", created_on=NOW, modified_by="client_user_001", modified_on=NOW,
        ),

        # ts6 (week -6): was first rejected, then employee resubmitted
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts6.id),
            approver_id=MANAGER_ID, approver_role=ApproverRoleEnum.MANAGER,
            approval_level=1, action=ApprovalActionEnum.REJECTED,
            comments="Missing task details. Please add notes and resubmit.",
            acted_at=NOW - timedelta(days=40),
            created_by=MANAGER_ID, created_on=NOW, modified_by=MANAGER_ID, modified_on=NOW,
        ),

        # ts5 (week -5): manager approved, then client rejected
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts5.id),
            approver_id=MANAGER_ID, approver_role=ApproverRoleEnum.MANAGER,
            approval_level=1, action=ApprovalActionEnum.APPROVED,
            acted_at=NOW - timedelta(days=33),
            created_by=MANAGER_ID, created_on=NOW, modified_by=MANAGER_ID, modified_on=NOW,
        ),
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts5.id),
            approver_id="client_user_001", approver_role=ApproverRoleEnum.CLIENT,
            approval_level=2, action=ApprovalActionEnum.REJECTED,
            comments="API hours don't match agreed scope. Please revise.",
            acted_at=NOW - timedelta(days=32),
            created_by="client_user_001", created_on=NOW, modified_by="client_user_001", modified_on=NOW,
        ),

        # ts4 (week -4): manager approved
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts4.id),
            approver_id=MANAGER_ID, approver_role=ApproverRoleEnum.MANAGER,
            approval_level=1, action=ApprovalActionEnum.APPROVED,
            comments="Looks good, approved.", acted_at=NOW - timedelta(days=25),
            created_by=MANAGER_ID, created_on=NOW, modified_by=MANAGER_ID, modified_on=NOW,
        ),

        # ts2 (week -2): manager rejected
        ApprovalRecord(
            organisation_id=ORG_ID, weekly_timesheet_id=str(ts2.id),
            approver_id=MANAGER_ID, approver_role=ApproverRoleEnum.MANAGER,
            approval_level=1, action=ApprovalActionEnum.REJECTED,
            comments="Documentation hours seem too high for this sprint. Please review and correct.",
            acted_at=NOW - timedelta(days=12),
            created_by=MANAGER_ID, created_on=NOW, modified_by=MANAGER_ID, modified_on=NOW,
        ),
    ]
    await ApprovalRecord.insert_many(approvals)
    print(f"  {len(approvals)} records")

    # ─── SUMMARY ──────────────────────────────────────────────
    print("\n" + "=" * 64)
    print("  SEED COMPLETE")
    print("=" * 64)
    print(f"""
Config:
  Settings: max 12h/day, max 50h/week, no deadline enforcement
  Approval: L1 manager required, client approval optional
  Past entries allowed up to 90 days

Data:
  2 Clients  |  3 Projects  |  7 Tasks  |  {len(pt_docs)} project-task links
  Employee on all 3 projects  |  Manager on all 3 projects

Employee timesheets (login as employeeuser7477@yopmail.com):
  -7w  client_approved  40h  (final - fully done)
  -6w  resubmitted     40h  (pending manager re-review)
  -5w  client_rejected  40h  (can edit & resubmit)
  -4w  l1_approved      40h  (approved by manager)
  -3w  submitted        40h  (pending manager review)
  -2w  l1_rejected      40h  (can edit & resubmit)
  -1w  draft            33h  (partial - can add hours & submit)
   0w  <none>                 (create new timesheet via UI)

What you can test as employee:
  1. Dashboard summary cards (counts per status)
  2. Create new timesheet for current week
  3. Add entries across multiple projects/tasks
  4. Submit the current week timesheet
  5. Open last week's draft -> add Friday hours -> submit
  6. Open -2w rejected timesheet -> edit hours -> resubmit
  7. Open -5w client-rejected -> edit -> resubmit
  8. View approved timesheets (read-only)
  9. Calendar view with color-coded project hours
  10. Filter by status in list view

Manager workflow (login as manager8462@yopmail.com):
  Sees employee's submitted/resubmitted timesheets
  Can approve or reject with comments
""")

    motor.close()


if __name__ == "__main__":
    asyncio.run(seed())
