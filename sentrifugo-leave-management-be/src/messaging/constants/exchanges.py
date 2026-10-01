from src.config import settings

ENV = settings.ENVIRONMENT


class Exchanges:
    IAM = f"{ENV}.iam.exchange"
    LMS = f"{ENV}.lms.exchange"
    AUDIT = f"{ENV}.audit.exchange"
    DOMAIN_EVENTS = "domain_events"
    EMAIL_EVENTS = "email_events"
