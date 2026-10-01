from urllib.parse import quote_plus

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GlobalConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = ["*"]

    # MS SQL Server (source database to crawl)
    MSSQL_HOST: str = "localhost"
    MSSQL_PORT: int = 1433
    MSSQL_USER: str = "sa"
    MSSQL_PASSWORD: str = ""
    MSSQL_DB_NAME: str = "sentrifugo"
    MSSQL_ODBC_DRIVER: str = "ODBC Driver 18 for SQL Server"
    MSSQL_TRUST_SERVER_CERTIFICATE: bool = True

    @computed_field
    @property
    def MSSQL_URL(self) -> str:
        trust = "yes" if self.MSSQL_TRUST_SERVER_CERTIFICATE else "no"
        return (
            f"mssql+aioodbc://{quote_plus(self.MSSQL_USER)}:{quote_plus(self.MSSQL_PASSWORD)}"
            f"@{self.MSSQL_HOST}:{self.MSSQL_PORT}/{self.MSSQL_DB_NAME}"
            f"?driver={quote_plus(self.MSSQL_ODBC_DRIVER)}&TrustServerCertificate={trust}"
        )


settings = GlobalConfig()
