from src.dashboard.schemas import DashboardStats

async def get_dashboard_stats() -> DashboardStats:
    # Aggregating mock statistics representing business logic
    return DashboardStats(
        total_users=150,
        active_sessions=12,
        system_health="Operational"
    )
