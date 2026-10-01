"""Show every employee's email and their decrypted payslip PIN.

Usage:
    python -m scripts.show_employee_pins

Reads from the employee_pin collection, joins to users for email,
and decrypts each PIN using the AES-256-GCM key derived from ENCRYPTION_KEY.
"""

import asyncio

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.config import settings
from src.modules.employee_pin.crypto import pin_decrypt
from src.modules.employee_pin.models import EmployeePinDocument


async def main():
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(database=db, document_models=[UserDocument, EmployeePinDocument])

    pins = await EmployeePinDocument.find({"deleted_on": None}).to_list()
    if not pins:
        print("No PIN records found.")
        return

    user_ids = [p.user_id for p in pins]
    users = await UserDocument.find({"_id": {"$in": user_ids}}).to_list()
    user_map = {u.id: u.email for u in users}

    print(f"{'Email':<45} {'PIN'}")
    print("-" * 55)
    for p in pins:
        email = user_map.get(p.user_id, "<unknown>")
        if p.cipher_text and p.iv_key:
            try:
                pin = pin_decrypt(p.cipher_text, p.iv_key)
            except Exception as e:
                pin = f"<decrypt error: {e}>"
        else:
            pin = "<not set>"
        print(f"{email:<45} {pin}")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
