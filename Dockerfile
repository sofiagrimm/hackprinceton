FROM python:3.13-slim

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend
COPY scripts scripts
# Derived indexes built by scripts/build_index.py + fetch_matterport.py. They are
# git-ignored (CoStar data is hackathon-only) and uploaded with `railway up --no-gitignore`.
COPY data/index data/index

WORKDIR /app/backend
ENV PYTHONUNBUFFERED=1
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
