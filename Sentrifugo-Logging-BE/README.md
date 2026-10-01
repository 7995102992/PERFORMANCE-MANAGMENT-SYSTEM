# Sentrifugo-BE Boilerplate

A production-ready FastAPI boilerplate built around strict security, domain-driven architecture, and asynchronous infrastructure execution patterns.

## 🚀 Getting Started

### Prerequisites
- **Python 3.10+** (Async functionality native)
- **Database**: PostgreSQL or MongoDB
- **Cache**: Redis / Valkey
- **Message Broker**: RabbitMQ

### Installation

1. **Clone the repository and enter directory:**
   ```bash
   git clone <repo_url>
   cd Sentrifugo-BE-Boilerplate
   ```

2. **Create and activate a virtual environment:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Environment Setup:**
   Copy the example environment variables file and fill it with your credentials:
   ```bash
   cp .env.example .env
   ```
   **Crucial Variables**:
   - `DB_TYPE`: `postgres` or `mongodb`
   - `DATABASE_URL`: Your connection string
   - `JWT_SECRET_KEY`: Keep this secure in production!

### Running the Application

Start the FastAPI application natively with Uvicorn:
```bash
uvicorn src.main:app --reload
```
Access the interactive API documentation at `http://127.0.0.1:8000/docs`.


## 🏗️ Architecture & Domain-Driven Design

We organize our codebase **by domain, not by file type**. All feature logic must stay perfectly isolated in its respective `src/{domain}` folder.

```text
src/
├── {domain}/           # e.g., auth/, health/, dashboard/
│   ├── router.py       # FastAPI endpoints for this domain
│   ├── schemas.py      # Request/Response Pydantic models
│   ├── service.py      # Core business logic
│   ├── dependencies.py # API request validators & Dependency Injection
│   ├── config.py       # Domain-scoped BaseSettings
│   ├── exceptions.py   # Domain-specific errors
│   └── utils.py        # Helper tools
├── config.py           # Global settings
├── models.py           # Global Base Models (`CustomModel`)
├── exceptions.py       # Global exception handlers
├── database.py         # DB connection pools
└── main.py             # App init and Router mapping
```


## ✍️ How to Write New Features

When creating a new feature (e.g., `users`), strictly follow these guidelines:

### 1. Define Schemas (`src/users/schemas.py`)
**Never** accept raw `dict` or untyped JSON. Always create explicit Pydantic response and request models wrapping the global `CustomModel` to ensure strict validation.
```python
from pydantic import Field
from src.models import CustomModel

class UserCreate(CustomModel):
    username: str = Field(min_length=3, max_length=50)
    email: str

class UserResponse(CustomModel):
    id: int
    username: str
```

### 2. Implement Business Logic (`src/users/service.py`)
All core logic stays isolated here. Make asynchronous calls to your DB, Redis, or external APIs. 
```python
async def create_new_user(user_data: dict, db_session) -> dict:
    # Perform business logic / DB insertions here
    return {"id": 1, "username": user_data["username"]}
```

### 3. Expose through Router (`src/users/router.py`)
API Endpoints map directly to the `service.py`. Keep routes lightweight!
- Always inject cross-cutting concerns (DB sessions, current user) via `Depends()`.
- Use specific HTTP status code enums (`status.HTTP_201_CREATED`).
```python
from fastapi import APIRouter, Depends, status
from src.database import get_db_session
from src.users.schemas import UserCreate, UserResponse
from src.users.service import create_new_user
from src.auth.dependencies import get_current_user

router = APIRouter(prefix="/users", tags=["users"])

@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: UserCreate, 
    db_session=Depends(get_db_session),
    current_user=Depends(get_current_user) # Protected Route!
):
    result = await create_new_user(payload.model_dump(), db_session)
    return UserResponse(**result)
```

### 4. Register Router (`src/main.py`)
Link your new router into the global ASGI application:
```python
from src.users.router import router as users_router
app.include_router(users_router)
```


## 🛡️ Security & Coding Standards
- **Always Async**: Use `async def` and non-blocking `await` calls. Offload CPU-heavy logic via `run_in_threadpool`.
- **Absolute Typing**: All function signatures must be strictly type-hinted.
- **Never swallow errors**: Never use bare `except:`. Throw `DomainException` to safely format 400/500 errors preventing stack-trace leaks.
- Use explicit module names when importing cross-domain elements:
  ```python
  from src.auth import dependencies as auth_dependencies
  ```


## 🧪 Testing & Linting
Our testing relies identically on async architecture verifying against a fully integrated ASGI environment.

### Lint and Auto-Format
```bash
ruff check --fix src tests
ruff format src tests
```

### Run Tests
```bash
pytest tests/ -v
```