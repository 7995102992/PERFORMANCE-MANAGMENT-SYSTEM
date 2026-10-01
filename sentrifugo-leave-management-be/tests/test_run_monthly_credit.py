"""Leave-type selection parsing for scripts/run_monthly_credit.py.

The script writes to production, so the answer typed at its prompt has to be
parsed unambiguously: a token it silently misreads becomes leave credited to the
wrong people.
"""

import pytest

from scripts.run_monthly_credit import _resolve_selection

NAMES = ["Casual Leave", "Earned Leave", "Sick Leave"]


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("1", ["Casual Leave"]),
        ("1,3", ["Casual Leave", "Sick Leave"]),
        ("1, 2 , 3", ["Casual Leave", "Earned Leave", "Sick Leave"]),
        ("Sick Leave", ["Sick Leave"]),
        ("sick leave", ["Sick Leave"]),
        ("SICK LEAVE", ["Sick Leave"]),
        ("1,Sick Leave", ["Casual Leave", "Sick Leave"]),
    ],
)
def test_numbers_and_names_both_resolve(raw, expected):
    chosen, unknown = _resolve_selection(raw, NAMES)
    assert chosen == expected
    assert unknown == []


def test_selection_order_follows_what_was_typed():
    chosen, _ = _resolve_selection("3,1", NAMES)
    assert chosen == ["Sick Leave", "Casual Leave"]


def test_repeats_are_collapsed():
    """'1,Casual Leave,1' must not credit the same type three times."""
    chosen, unknown = _resolve_selection("1,Casual Leave,1", NAMES)
    assert chosen == ["Casual Leave"]
    assert unknown == []


@pytest.mark.parametrize("raw", ["0", "4", "99"])
def test_out_of_range_numbers_are_rejected_not_clamped(raw):
    """An index past the menu must be reported, never silently mapped to an edge."""
    chosen, unknown = _resolve_selection(raw, NAMES)
    assert chosen == []
    assert unknown == [raw]


def test_unknown_names_are_reported():
    chosen, unknown = _resolve_selection("Casual Leave,Maternity", NAMES)
    assert chosen == ["Casual Leave"]
    assert unknown == ["Maternity"]


def test_a_partial_name_is_not_treated_as_a_match():
    """Substring matching would make 'Leave' ambiguous across every type."""
    chosen, unknown = _resolve_selection("Leave", NAMES)
    assert chosen == []
    assert unknown == ["Leave"]


def test_empty_and_stray_separators_yield_nothing():
    for raw in ("", "   ", ",", " , , "):
        chosen, unknown = _resolve_selection(raw, NAMES)
        assert chosen == []
        assert unknown == []
