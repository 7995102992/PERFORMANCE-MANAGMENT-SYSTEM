"""Generate a single, self-contained HTML preview of every email template.

Renders each template in src/email/templates/*.html with representative sample
data and embeds them all (via <iframe srcdoc>) into ONE file:
docs/email-templates-preview.html — a committed design reference. Re-run after
changing any template or the shared header/footer.

Usage:
  python -m scripts.generate_email_previews

Notes:
  * Sample data is a shared superset covering every {{placeholder}}, so each
    template renders with no unfilled variables.
  * The footer "Raise a request in Sentrifugo" link resolves from the same
    .env values the app uses (FRONTEND_BASE_URL / SUPPORT_CATEGORY_ID / SUPPORT_SUBTYPE_ID).
  * client_review_request_v1's {{employee_rows}}/{{grand_total_row}} are
    publisher-supplied HTML blocks, left blank here (the renderer HTML-escapes
    values, so raw markup can't be previewed).
"""

import glob
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.email.templates.renderer import get_subject, render_template  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_GLOB = os.path.join(_ROOT, "src", "email", "templates", "*.html")
OUT_FILE = os.path.join(_ROOT, "docs", "email-templates-preview.html")

_CHECKLIST = (
    "The following items were recorded at this stage:\n"
    "✓ Laptop allocated\n✓ Email account created\n"
    "– VPN access granted\n     Reason: Candidate is office-only; VPN not required."
)
_CLEARANCES = (
    "IT Clearance:\n✓ Laptop allocated\n✓ Email account created\n\n"
    "Admin Clearance:\n✓ ID card issued\n\n"
    "Finance Clearance:\n✓ Payroll set up"
)

_OVERRIDES = {
    "org_name": "Sagarsoft",
    "company_address": "Sagarsoft Technologies, Hyderabad, India",
    "candidate_name": "Gita Teal", "employee_name": "Gita Teal", "display_name": "Gita Teal",
    "recipient_name": "Gita Teal", "requester_name": "Gita Teal",
    "approver_name": "Gopal Nair", "manager_name": "Venkat Raman", "reporting_manager_name": "Venkat Raman",
    "client_name": "Acme Corp", "executor_name": "Ravi Kumar", "hr_name": "Meera Nair",
    "stage_label": "IT Clearance", "onboarding_code": "ONB-2026-0031", "requisition_id": "REQ-1043",
    "request_code": "EXIT-2026-0007", "request_id": "SRM-1043", "ticket_id": "SRM-1043",
    "department_name": "Engineering", "project_name": "Apollo Platform", "category": "Hardware",
    "priority": "High", "status": "Open", "subject": "Laptop not booting",
    "description": "My laptop won't power on after the update.",
    "reason": "Candidate is office-only; VPN not required.", "comment": "Please review at the earliest.",
    "checklist_text": _CHECKLIST, "clearances_text": _CLEARANCES, "pin": "428913",
    "expiry_hours": "48", "total_hours": "40", "grand_total_hours": "160", "timesheet_count": "5",
    "budget_percent": "85", "days_pending": "3", "week_range": "8–14 Jun 2026",
    "week_start": "2026-06-08", "week_end": "2026-06-14", "last_working_day": "31 Aug 2026",
    "period": "June 2026", "holiday_name": "Independence Day", "holiday_date": "15 Aug 2026",
    "calendar_name": "India 2026", "shift_name": "Morning (9–6)", "plan_name": "India Holidays 2026",
    # publisher-supplied HTML row blocks — blank (renderer escapes values)
    "employee_rows": "", "grand_total_row": "",
}

_ORDER = ["Account", "Onboarding", "Service Request (SRM)", "Leave", "Exit", "Timesheet",
          "Holiday", "Work Calendar", "Shift", "Payroll", "Projects", "Other"]

# Injected by render_template itself (raise_ticket_link from .env, current year).
# Must NOT be supplied as sample data or they'd override the real values, since
# template_data is merged last.
_RENDERER_INJECTED = {"raise_ticket_link", "year"}


def _value(key: str) -> str:
    if key in _OVERRIDES:
        return _OVERRIDES[key]
    k = key.lower()
    if k.endswith(("_rows", "_row")):
        return ""
    if "email" in k:
        return "gita.teal@yopmail.com"
    if k.endswith(("_link", "_url")):
        return "https://app.sentrifugo.com/go"
    if any(t in k for t in ("_on", "_at", "date", "day")):
        return "27 July 2026 at 10:25 UTC"
    if any(t in k for t in ("hours", "count", "percent", "days", "number", "total", "amount")):
        return "42"
    return key.replace("_", " ").title()


def _group_of(tid: str) -> str:
    if tid.startswith("onboarding_"):
        return "Onboarding"
    if tid.startswith("srm_"):
        return "Service Request (SRM)"
    if tid.startswith("leave_"):
        return "Leave"
    if tid.startswith("exit_"):
        return "Exit"
    if tid.startswith("timesheet_") or tid in ("employee_timesheet_reminder_v1", "client_review_request_v1"):
        return "Timesheet"
    if tid.startswith("holiday_"):
        return "Holiday"
    if tid.startswith("work_calendar_"):
        return "Work Calendar"
    if tid.startswith("shift_"):
        return "Shift"
    if tid in ("activation_v1", "password_reset_v1", "email_change_v1"):
        return "Account"
    if tid.startswith("payslip_"):
        return "Payroll"
    if tid.startswith("budget_"):
        return "Projects"
    return "Other"


def _anchor(group: str) -> str:
    return html.escape(group).replace(" ", "-").replace("(", "").replace(")", "")


def main() -> None:
    files = sorted(glob.glob(TEMPLATE_GLOB))

    keys: set[str] = set()
    for p in files:
        keys |= set(re.findall(r"{{([a-zA-Z0-9_]+)}}", open(p, encoding="utf-8").read()))
    data = {k: _value(k) for k in keys if k not in _RENDERER_INJECTED}

    esc = html.escape
    by_group: dict[str, list] = {}
    unfilled_total = 0
    for p in files:
        tid = os.path.splitext(os.path.basename(p))[0]
        body = render_template(tid, dict(data))
        subject = get_subject(tid, dict(data))
        if re.search(r"{{[^}]+}}", body):
            unfilled_total += 1
        by_group.setdefault(_group_of(tid), []).append((tid, subject, body))

    sections = []
    total = 0
    for g in _ORDER:
        if g not in by_group:
            continue
        cards = []
        for tid, subject, body in sorted(by_group[g]):
            total += 1
            cards.append(
                f'  <section class="card"><div class="meta"><span class="tid">{esc(tid)}</span>\n'
                f'      <div class="kv"><b>Subject:</b> {esc(subject)}</div></div>\n'
                f'      <iframe loading="lazy" srcdoc="{esc(body, quote=True)}" title="{esc(tid)}"></iframe></section>'
            )
        sections.append(
            f'<h2 id="{_anchor(g)}">{esc(g)} <span class="cnt">({len(by_group[g])})</span></h2>\n'
            f'<div class="wrap">\n' + "\n".join(cards) + "\n</div>"
        )

    nav = " &middot; ".join(f'<a href="#{_anchor(g)}">{esc(g)}</a>' for g in _ORDER if g in by_group)
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>All email templates — design review</title>
<style>:root{{color-scheme:light dark}}*{{box-sizing:border-box}}body{{margin:0;font-family:"Segoe UI",Roboto,Arial,sans-serif;background:#eef1f5;color:#11023B}}
header{{padding:18px 24px;background:#11023B;color:#fff;position:sticky;top:0;z-index:3}}header h1{{margin:0;font-size:18px}}
header p{{margin:4px 0 8px;font-size:13px;opacity:.85}}nav a{{color:#c9c2ff;text-decoration:none;font-size:12px}}nav a:hover{{text-decoration:underline}}
h2{{margin:28px 24px 4px;font-size:15px;scroll-margin-top:92px}}h2 .cnt{{color:#6C6F89;font-weight:400}}
.wrap{{display:grid;grid-template-columns:repeat(auto-fit,minmax(600px,1fr));gap:20px;padding:12px 24px 8px}}
.card{{background:#fff;border:1px solid #d9dee6;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.meta{{padding:10px 14px;border-bottom:1px solid #e5e7eb;background:#F7FAFF}}
.tid{{display:inline-block;font-family:ui-monospace,Consolas,monospace;font-size:12px;font-weight:700;color:#6F5CFF;background:#efeaff;padding:2px 8px;border-radius:5px}}
.kv{{font-size:12.5px;color:#374151;margin-top:6px}}.kv b{{color:#11023B}}
iframe{{width:100%;height:720px;border:0;background:#f5f7fa;display:block}}@media(max-width:660px){{.wrap{{grid-template-columns:1fr}}}}</style></head>
<body><header><h1>All email templates &mdash; design review</h1>
<p>{total} templates, self-contained in this single file &bull; footer link resolved from .env &bull; regenerate with scripts/generate_email_previews.py</p>
<nav>{nav}</nav></header>
{"".join(sections)}
</body></html>"""

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8", newline="") as f:
        f.write(page)

    size_kb = os.path.getsize(OUT_FILE) // 1024
    print(f"Wrote {total} templates into single file: {OUT_FILE} ({size_kb} KB)")
    if unfilled_total:
        print(f"WARNING: {unfilled_total} template(s) had unfilled variables")


if __name__ == "__main__":
    main()
