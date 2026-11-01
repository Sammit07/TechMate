"""Application settings, read from environment variables.

Locally they come from the repository's .env file; on Vercel from the project's
environment variables. Settings are validated once at startup so a missing value
fails fast with a clear message instead of a confusing error mid-request.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator

ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")  # no-op on Vercel, where the file doesn't exist


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip().strip('"').strip("'")


class Settings(BaseModel):
    # Nebius Token Factory
    token_factory_base_url: str
    token_factory_api_key: str
    model_fast: str
    model_reasoning: str
    embed_model: str
    embed_dimensions: int = Field(1024, ge=64, le=4096)

    # FalkorDB
    falkordb_host: str
    falkordb_port: int
    falkordb_username: str = "falkordb"
    falkordb_password: str
    falkordb_ssl: bool = False
    graph_name: str = "it_support"

    # API
    cors_origins: list[str] = ["http://localhost:3000"]
    rate_limit_chat_per_minute: int = 12
    rate_limit_write_per_minute: int = 20

    # Uploads (ticket CSVs, knowledge documents, operational notices)
    admin_token: str = ""            # if set, uploads and deletes need the X-Admin-Token header
    max_upload_mb: float = 4.0       # Vercel functions accept request bodies up to 4.5 MB
    upload_dir: Path = ROOT_DIR / "data" / "uploads"

    # Sign-in: one shared app password. Empty = no sign-in (local development only).
    app_password: str = ""
    auth_secret: str = ""            # signs session cookies; derived from APP_PASSWORD if empty
    session_days: int = Field(7, ge=1, le=90)

    # Workspaces: each is its own graph; the registry lives in META_GRAPH.
    meta_graph: str = "techmate_meta"
    default_workspace_name: str = "Acme Global IT (demo)"

    @field_validator("token_factory_base_url", "token_factory_api_key", "model_fast", "model_reasoning",
                     "embed_model", "falkordb_host", "falkordb_password")
    @classmethod
    def _required(cls, v: str, info) -> str:
        if not v:
            raise ValueError(f"{info.field_name.upper()} is not set")
        return v


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        token_factory_base_url=_env("TOKEN_FACTORY_BASE_URL"),
        token_factory_api_key=_env("TOKEN_FACTORY_API_KEY"),
        model_fast=_env("MODEL_FAST"),
        model_reasoning=_env("MODEL_REASONING"),
        embed_model=_env("EMBED_MODEL"),
        embed_dimensions=int(_env("EMBED_DIMENSIONS", "1024")),
        falkordb_host=_env("FALKORDB_HOST"),
        falkordb_port=int(_env("FALKORDB_PORT", "6379") or 6379),
        falkordb_username=_env("FALKORDB_USERNAME", "falkordb"),
        falkordb_password=_env("FALKORDB_PASSWORD"),
        falkordb_ssl=_env("FALKORDB_SSL", "false").lower() == "true",
        graph_name=_env("GRAPH_NAME", "it_support"),
        cors_origins=[o.strip() for o in _env("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()],
        rate_limit_chat_per_minute=int(_env("RATE_LIMIT_CHAT_PER_MINUTE", "12")),
        rate_limit_write_per_minute=int(_env("RATE_LIMIT_WRITE_PER_MINUTE", "20")),
        admin_token=_env("ADMIN_TOKEN"),
        max_upload_mb=float(_env("MAX_UPLOAD_MB", "4") or 4),
        upload_dir=Path(_env("UPLOAD_DIR") or ROOT_DIR / "data" / "uploads"),
        app_password=_env("APP_PASSWORD"),
        auth_secret=_env("AUTH_SECRET"),
        session_days=int(_env("SESSION_DAYS", "7") or 7),
        meta_graph=_env("META_GRAPH", "techmate_meta"),
        default_workspace_name=_env("DEFAULT_WORKSPACE_NAME", "Acme Global IT (demo)"),
    )
