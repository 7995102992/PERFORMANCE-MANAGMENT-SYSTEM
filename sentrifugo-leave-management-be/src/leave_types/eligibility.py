"""Who is a leave type available to?

A leave type can be restricted to a gender and/or a marital status (Maternity to
women, Paternity to men, and so on). That rule is enforced in two places:

  * the LISTING surfaces — the apply dropdown, the balance card — hide types the
    employee can never use (``filter_eligible``);
  * the APPLY path rejects a request for a restricted type outright
    (``restriction_error`` in ``src.leave_requests.service``).

Filtering alone would not be a control — a client can post any leave_type_id —
so hiding is a usability layer over the real gate, never a replacement for it.

Storage note: the leave type holds an uppercase token (``MALE`` / ``FEMALE`` /
``SINGLE`` / ``MARRIED``); the employee replica holds the IAM master-data key
(``male`` / ``married``). Compared case-insensitively.

Unknown attributes: the two layers deliberately DIFFER, via ``unknown_blocks``.

  * Listing (``unknown_blocks=False``) shows the type. An employee whose gender
    never synced from IAM would otherwise face a list with the restricted types
    silently missing and no explanation.
  * Apply (``unknown_blocks=True``) refuses it. Letting an unknown gender
    through means anyone with a gap in their profile can take Maternity Leave —
    the restriction would be advisory rather than enforced.

So the gap surfaces as a clear, fixable error at the moment it matters instead
of either hiding options or waving a restricted request through. The error names
the missing field so the employee knows to get their profile completed.
"""

from typing import Optional


def is_unrestricted_type(leave_type: Optional[dict]) -> bool:
    """True when this type waives the entitlement gates on the apply path.

    Lifted for an unrestricted type:
      * the "no entitlement policy for this leave type" refusal;
      * the inactive employment-status block (absconded / exit / retired / …);
      * the probation single-leave-type restriction;
      * the available-balance check, and the balance hold that follows it.

    NOT lifted — these are about who the type is *for*, and about approval,
    neither of which "unrestricted" is claiming to change:
      * the gender / marital-status restrictions in this module;
      * the approval workflow;
      * sandwich rules, working-day counting, upload/comment requirements.
    """
    return bool((leave_type or {}).get("is_unrestricted"))


def _restriction_tokens(leave_type: dict) -> tuple[Optional[str], Optional[str]]:
    """(gender, marital_status) required by this type, if any.

    Reads ``restrictions``, falling back to the legacy top-level
    ``gender_restriction`` / ``marital_status_restriction`` fields that older
    documents carry.
    """
    lt = leave_type or {}
    restrictions = lt.get("restrictions") or {}
    return (
        restrictions.get("gender") or lt.get("gender_restriction"),
        restrictions.get("marital_status") or lt.get("marital_status_restriction"),
    )


def _attribute_reason(
    required: Optional[str],
    actual: Optional[str],
    *,
    unknown_blocks: bool,
    label: str,
    mismatch_code: str,
    missing_code: str,
) -> Optional[tuple[str, str]]:
    """``(code, message)`` when this one attribute disqualifies the employee."""
    if not required:
        return None

    if not actual:
        # Attribute unknown: never synced from IAM, or no employee record.
        if not unknown_blocks:
            return None
        return (
            missing_code,
            f"This leave type is restricted to {str(required).lower()} employees, but your "
            f"profile has no {label} recorded. Ask HR to update your profile, then try again.",
        )

    if str(actual).lower() != str(required).lower():
        return (
            mismatch_code,
            f"This leave type is restricted to {str(required).lower()} employees",
        )
    return None


def ineligibility_reason(
    leave_type: dict, employee: Optional[dict], *, unknown_blocks: bool = False
) -> Optional[tuple[str, str]]:
    """``(error_code, message)`` when the employee may not use this type, else None.

    ``unknown_blocks`` decides what an unknown gender / marital status means —
    see the module docstring. Listing surfaces leave it False; the apply gate
    sets it True.
    """
    req_gender, req_marital = _restriction_tokens(leave_type)
    emp = employee or {}

    reason = _attribute_reason(
        req_gender,
        emp.get("gender"),
        unknown_blocks=unknown_blocks,
        label="gender",
        mismatch_code="GENDER_NOT_ELIGIBLE",
        missing_code="GENDER_NOT_ON_PROFILE",
    )
    if reason:
        return reason

    return _attribute_reason(
        req_marital,
        emp.get("marital_status"),
        unknown_blocks=unknown_blocks,
        label="marital status",
        mismatch_code="MARITAL_STATUS_NOT_ELIGIBLE",
        missing_code="MARITAL_STATUS_NOT_ON_PROFILE",
    )


def is_eligible(
    leave_type: dict, employee: Optional[dict], *, unknown_blocks: bool = False
) -> bool:
    return ineligibility_reason(leave_type, employee, unknown_blocks=unknown_blocks) is None


def filter_eligible(leave_types: list[dict], employee: Optional[dict]) -> list[dict]:
    """Drop the types this employee is definitively not eligible for.

    Only a KNOWN, mismatching attribute hides a type. An unknown one keeps it
    visible — the apply gate then explains why it cannot be used, which beats a
    type vanishing from the list with no reason given.

    ``employee=None`` means "caller has no employee record" (admins, for one) —
    nothing is filtered.
    """
    if employee is None:
        return list(leave_types)
    return [lt for lt in leave_types if is_eligible(lt, employee)]
