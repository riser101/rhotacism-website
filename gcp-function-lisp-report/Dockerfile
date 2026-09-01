FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# WeasyPrint system dependencies (Pango + friends) for PDF rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
      libffi-dev libcairo2 shared-mime-info fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY assets ./assets

# Cloud Run injects $PORT. Rendering a report takes ~1-2s; timeout is generous.
CMD exec gunicorn --bind :${PORT:-8080} --workers 2 --threads 8 --timeout 120 app:app
