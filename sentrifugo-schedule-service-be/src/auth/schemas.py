from typing import Optional
from src.models import CustomModel

class TokenResponse(CustomModel):
    access_token: str
    token_type: str

class UserBase(CustomModel):
    username: str
    email: Optional[str] = None
    full_name: Optional[str] = None
