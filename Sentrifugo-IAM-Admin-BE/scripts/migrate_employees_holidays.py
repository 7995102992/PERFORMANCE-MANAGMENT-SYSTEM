"""Employees + holidays — one command for the people side of the migration.

Phases (in order):
  1. IAM         — org / BUs / departments / designations / employees  (rejoined
                   people are linked to ONE real-email account here — no second
                   login, both stints kept; + emit BU/department/employee events)
  2. LMS sync    — push BUs / departments / employees into the leave DB (dev
                   bridge; PRODUCTION does this via the RabbitMQ events above)
  3. LMS holidays— 'Holiday' classification / plans (per Group×Year) / holidays /
                   employee assignments (active employees)

Each phase is its own standalone script (runnable on its own); this just chains
them so a single command does the people + holidays. Each phase writes its own report.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.migrate_employees_holidays                # DRY RUN every phase (no writes)
    python -m scripts.migrate_employees_holidays --commit       # run employees + holidays
    python -m scripts.migrate_employees_holidays --revert       # undo these phases (reverse order)
"""

import argparse
import subprocess
import sys

def run(module: str, extra: list[str]) -> None:
    cmd = [sys.executable, "-m", module, *extra]
    print(f"\n{'=' * 72}\n$ {' '.join(cmd)}\n{'=' * 72}")
    rc = subprocess.run(cmd).returncode
    if rc != 0:
        print(f"\n!! PHASE FAILED: {module} (exit {rc}). Stopping the orchestrator.")
        sys.exit(rc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="perform the migration (default: dry run all phases)")
    ap.add_argument("--revert", action="store_true", help="undo all phases in reverse order")
    ap.add_argument("--org-id", help="organisation id forwarded to every phase (default: each phase's own)")
    ap.add_argument("--activation", action="store_true",
                    help="create employees as PENDING and email each an activation link "
                         "(default: active with password test@123)")
    ap.add_argument("--data-dir", help="folder holding the export files, forwarded to the phases "
                    "that read files (employees + holidays)")
    args = ap.parse_args()

    # Forward one org id down to every phase (optional; omit = each phase's default).
    org = ["--org-id", args.org_id] if args.org_id else []
    # Phase 1 employee importer: with-email (activation) or no-email (active).
    emp_module = "scripts.migrate_employees_activation" if args.activation else "scripts.migrate_employees_active"

    if args.revert:
        # Reverse order so dependents go first: holidays -> LMS copies -> IAM.
        run("scripts.lms_holidays", ["--revert", *org])
        run("scripts.sync_org_to_lms", ["--revert", *org])
        run(emp_module, ["--revert", *org])
        print(f"\n{'=' * 72}\nREVERT COMPLETE — all three phases undone.\n{'=' * 72}")
        return

    emp_label = "activation email" if args.activation else "active, test@123"
    datadir = ["--data-dir", args.data_dir] if args.data_dir else []
    phases = [
        (f"1/3  IAM: employees ({emp_label})", emp_module, ["--emit-events", *datadir]),
        ("2/3  LMS sync: BUs / departments / employees -> leave DB", "scripts.sync_org_to_lms", []),
        ("3/3  LMS holidays: classification / plans / holidays / assignments", "scripts.lms_holidays", [*datadir]),
    ]

    flag = ["--commit"] if args.commit else []
    for label, module, extra in phases:
        print(f"\n### PHASE {label}")
        run(module, [*extra, *flag, *org])

    state = "COMMITTED" if args.commit else "DRY-RUN (no writes)"
    print(f"\n{'=' * 72}\nALL PHASES {state} OK\n"
          f"Reports: scripts/sagarsoft_import_report.md  +  scripts/holiday_import_report.md\n"
          f"{'=' * 72}")


if __name__ == "__main__":
    main()
