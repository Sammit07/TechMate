"""Vercel entrypoint: Vercel loads the `app` variable from this file (service entrypoint main:app).

Run locally:  uvicorn main:app --app-dir backend --port 8000 --reload
"""

from app.api import app

__all__ = ["app"]
