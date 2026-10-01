from src.models import CustomModel

class DashboardStats(CustomModel):
    total_users: int
    active_sessions: int
    system_health: str
