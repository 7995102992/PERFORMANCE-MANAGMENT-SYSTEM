"""Every email that reaches a person carries a deep link back to the ticket.

Static analysis of ``src/email_events.py`` — no DB, no broker, no auth — so it
runs standalone regardless of the API suite's environment needs.

Why this exists: five separate payloads shipped without a ``request_link``, and
every one of them was the *second* ``_publish_email`` inside a trigger whose
primary recipient was somebody else. The link got built for the primary
audience and the secondary send rode along without one. Nothing failed — the
mail arrived, it just had no way back to the ticket — so the gap survived until
someone noticed a missing button.

A signature check can't catch this: the trigger has ``sr_id``, it simply never
uses it for that one payload. The assertion has to be per-payload.
"""
from __future__ import annotations

import ast
import pathlib

import pytest

EMAIL_EVENTS = (
    pathlib.Path(__file__).resolve().parents[1] / "src" / "email_events.py"
)

LINK_KEYS = {"request_link", "approval_link"}

# Routing keys that legitimately carry no link. Empty on purpose: every mail
# currently sent is about one ticket and every recipient is a person who may
# want to open it. Add an entry here only with a reason — a digest with no
# single subject, or a mail to a system address.
NO_LINK_ALLOWED: dict[str, str] = {}


def _publish_calls() -> list[tuple[str, set[str], str]]:
    """(routing_key, template_data keys, enclosing function) per _publish_email."""
    tree = ast.parse(EMAIL_EVENTS.read_text(encoding="utf-8"))
    out: list[tuple[str, set[str], str]] = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Name) and func.id == "_publish_email"):
                continue
            routing_key = ""
            if node.args and isinstance(node.args[0], ast.Constant):
                routing_key = str(node.args[0].value)
            keys: set[str] = set()
            for kw in node.keywords:
                if kw.arg == "template_data" and isinstance(kw.value, ast.Dict):
                    keys = {
                        k.value
                        for k in kw.value.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)
                    }
            out.append((routing_key, keys, fn.name))
    return out


def test_publish_calls_are_discoverable():
    """Guard the guard: a rewrite that hides the calls must not pass silently."""
    calls = _publish_calls()
    assert len(calls) >= 11, f"only found {len(calls)} _publish_email calls"
    assert all(rk.startswith("email.srm.") for rk, _, _ in calls)


@pytest.mark.parametrize("routing_key,keys,fn_name", _publish_calls())
def test_every_payload_has_a_ticket_link(routing_key, keys, fn_name):
    if routing_key in NO_LINK_ALLOWED:
        pytest.skip(f"allow-listed: {NO_LINK_ALLOWED[routing_key]}")
    assert keys & LINK_KEYS, (
        f"{routing_key} (in {fn_name}) has no request_link/approval_link. "
        "If this payload genuinely should not link to the ticket, add it to "
        "NO_LINK_ALLOWED with a reason."
    )


@pytest.mark.parametrize("routing_key,keys,fn_name", _publish_calls())
def test_linked_payloads_carry_the_ticket_id(routing_key, keys, fn_name):
    """A link needs the Mongo id — ticket_no does not resolve the detail sheet."""
    if not keys & LINK_KEYS:
        pytest.skip("covered by test_every_payload_has_a_ticket_link")
    tree = ast.parse(EMAIL_EVENTS.read_text(encoding="utf-8"))
    sigs = {
        fn.name: {a.arg for a in fn.args.args + fn.args.kwonlyargs}
        for fn in ast.walk(tree)
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    assert "sr_id" in sigs.get(fn_name, set()), (
        f"{fn_name} builds a link but takes no sr_id, so it cannot address the "
        "ticket by its Mongo id"
    )
