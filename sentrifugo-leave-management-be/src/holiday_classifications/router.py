from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.holiday_classifications.schemas import (
    ClassificationCreate,
    ClassificationResponse,
    ClassificationUpdate,
)
from src.holiday_classifications.service import (
    create_classification,
    delete_classification,
    list_classifications,
    update_classification,
)

router = APIRouter(tags=["holiday-classifications"])


@router.post(
    "/holiday-classifications",
    response_model=ClassificationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_classification(
    payload: ClassificationCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ClassificationResponse:
    doc = await create_classification(db, payload, org_id=current_user.org_id, user_id=current_user.user_id)
    return ClassificationResponse.from_doc(doc)


@router.get("/holiday-classifications", response_model=list[ClassificationResponse])
async def get_classifications(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[ClassificationResponse]:
    docs = await list_classifications(db, org_id=current_user.org_id)
    return [ClassificationResponse.from_doc(d) for d in docs]


@router.put("/holiday-classifications/{classification_id}", response_model=ClassificationResponse)
async def modify_classification(
    classification_id: str,
    payload: ClassificationUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ClassificationResponse:
    doc = await update_classification(
        db, classification_id, payload,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return ClassificationResponse.from_doc(doc)


@router.delete("/holiday-classifications/{classification_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_classification(
    classification_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> None:
    await delete_classification(
        db, classification_id,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
