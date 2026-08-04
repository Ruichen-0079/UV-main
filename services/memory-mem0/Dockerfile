# Formal deploy baseline: Python 3.11 (not 3.12/3.13).
FROM python:3.11.11-slim-bookworm

WORKDIR /app

# Install from lock-exported requirements (see README dependency policy).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 6131
CMD ["python", "-m", "yuvi_mem0"]
