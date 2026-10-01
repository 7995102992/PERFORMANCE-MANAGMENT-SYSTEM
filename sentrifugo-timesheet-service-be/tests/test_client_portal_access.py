"""Turning on portal access for an existing client.

The contact gets an IAM login and an activation mail, exactly as they would if the
client had been created with portal access on. This path used to reference an
undefined `bcrypt` and pass a `password_hash` that `create_iam_user` does not
accept, so it raised NameError on every call.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.clients.schemas import ClientUpdate

_CLIENT = "507f1f77bcf86cd799439011"
_NEW_USER = "507f1f77bcf86cd7994390a1"


def make_client(**overrides):
    defaults = dict(
        id=_CLIENT,
        organisation_id="org1",
        name="Acme",
        name_lc="acme",
        contact_person="Jane Roe",
        contact_email="jane@acme.test",
        contact_user_id=None,
        portal_access_enabled=True,
        deleted_on=None,
        business_unit_ids=[],
        department_ids=[],
    )
    defaults.update(overrides)
    doc = MagicMock()
    doc.save = AsyncMock()
    for key, value in defaults.items():
        setattr(doc, key, value)
    return doc


async def update(doc, body, *, existing_login=None):
    from src.clients import service

    with patch("src.clients.service._load_or_404", AsyncMock(return_value=doc)), \
         patch("src.clients.service._find_by_name", AsyncMock(return_value=None)), \
         patch("src.clients.service.find_iam_user_by_email",
               AsyncMock(return_value=existing_login)), \
         patch("src.clients.service.create_iam_user", AsyncMock(return_value=_NEW_USER)) as create, \
         patch("src.clients.service.send_activation_email", AsyncMock()) as activate, \
         patch("src.clients.service.update_iam_user", AsyncMock()), \
         patch("src.clients.service._to_out", MagicMock(return_value={})), \
         patch("src.clients.service._attach_scope_names", AsyncMock()), \
         patch("src.clients.service.emit_audit", AsyncMock()):
        await service.update_client(_CLIENT, body, MagicMock(id="u1", organisation_id="org1"))
    return create, activate


class TestEnablingPortalAccess:
    @pytest.mark.asyncio
    async def test_a_contact_with_no_login_is_saved_without_one(self):
        """Account provisioning is switched off — the client update still succeeds."""
        doc = make_client()

        create, activate = await update(doc, ClientUpdate())

        assert doc.contact_user_id is None
        create.assert_not_awaited()
        activate.assert_not_awaited()
        doc.save.assert_awaited()

    @pytest.mark.asyncio
    async def test_an_existing_contact_user_is_left_alone(self):
        doc = make_client(contact_user_id="already-there")

        create, activate = await update(doc, ClientUpdate())

        create.assert_not_awaited()
        activate.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_portal_access_off_creates_nothing(self):
        create, activate = await update(make_client(portal_access_enabled=False), ClientUpdate())

        create.assert_not_awaited()
        activate.assert_not_awaited()


class TestContactEmailBelongingToSomeoneElse:
    """An address that already has a login — an employee, or another client's
    contact — is reused, and must not be sent an activation mail: that mail carries
    a live password-reset link for their existing account."""

    @pytest.mark.asyncio
    async def test_an_existing_login_is_reused(self):
        doc = make_client()

        create, activate = await update(doc, ClientUpdate(), existing_login="employee-user-id")

        assert doc.contact_user_id == "employee-user-id"
        create.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_activation_mail_is_sent_to_them(self):
        _, activate = await update(make_client(), ClientUpdate(), existing_login="employee-user-id")

        activate.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_nothing_is_provisioned_for_an_unknown_address_either(self):
        create, activate = await update(make_client(), ClientUpdate(), existing_login=None)

        create.assert_not_awaited()
        activate.assert_not_awaited()
