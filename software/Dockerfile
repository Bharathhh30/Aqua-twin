FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY software/pyproject.toml software/uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY software/aquatwin ./aquatwin
COPY software/config ./config
COPY software/web ./web
COPY index.html styles.css app.js favicon.svg ./
RUN mkdir -p /app/data

EXPOSE 8000
CMD ["uv", "run", "--project", "/app", "uvicorn", "aquatwin.api:app", "--host", "0.0.0.0", "--port", "8000"]
