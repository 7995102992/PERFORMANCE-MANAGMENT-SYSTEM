from pydantic import BaseModel, ConfigDict
from datetime import datetime

class CustomModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
    )
