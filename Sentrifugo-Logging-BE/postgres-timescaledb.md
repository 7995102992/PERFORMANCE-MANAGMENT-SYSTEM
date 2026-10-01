# PostgreSQL + TimescaleDB Setup Guide

This guide covers installing and configuring PostgreSQL with the TimescaleDB extension for the Sentrifugo Logging Backend.

---

## Option A: Docker (Recommended)

TimescaleDB publishes pre-built Docker images with PostgreSQL and the extension pre-installed.

### 1. Run the Container

```bash
docker run -d \
  --name sentrifugo-timescaledb \
  -p 5432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=sentrifugo \
  timescale/timescaledb:latest-pg16
```

### 2. Verify

```bash
docker exec -it sentrifugo-timescaledb psql -U postgres -d sentrifugo -c "\dx timescaledb"
```

You should see TimescaleDB listed with its version.

### 3. Stop / Start the Container

```bash
docker stop sentrifugo-timescaledb
docker start sentrifugo-timescaledb
```

### 4. Remove the Container (data will be lost)

```bash
docker rm -f sentrifugo-timescaledb
```

To persist data across container removals, add a volume:

```bash
docker run -d \
  --name sentrifugo-timescaledb \
  -p 5432:5432 \
  -v sentrifugo_pgdata:/var/lib/postgresql/data \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=sentrifugo \
  timescale/timescaledb:latest-pg16
```

---

## Option B: Native Installation

### Ubuntu / Debian

#### 1. Install PostgreSQL

```bash
sudo apt update && sudo apt install -y postgresql postgresql-contrib
```

#### 2. Install TimescaleDB

```bash
sudo apt install -y gnupg postgresql-common apt-transport-https lsb-release wget

echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list

wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -

sudo apt update
sudo apt install -y timescaledb-2-postgresql-16
```

#### 3. Tune and Restart

```bash
sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql
```

### macOS (Homebrew)

```bash
brew install postgresql@16
brew tap timescale/tap
brew install timescaledb
timescaledb-tune --quiet --yes
brew services restart postgresql@16
```

### Windows

1. Download and install PostgreSQL from https://www.postgresql.org/download/windows/
2. Download the TimescaleDB `.exe` installer from https://docs.timescale.com/self-hosted/latest/install/installation-windows/
3. Run the TimescaleDB installer and point it to your PostgreSQL installation directory.
4. Restart the PostgreSQL service from **Services** (`services.msc`) or:

```powershell
Restart-Service postgresql-x64-16
```

---

## Database Initialization

After PostgreSQL and TimescaleDB are installed, create the database and enable the extension.

### Connect to PostgreSQL

```bash
# Docker
docker exec -it sentrifugo-timescaledb psql -U postgres

# Native (Linux)
sudo -u postgres psql

# Native (macOS / Windows)
psql -U postgres
```

### Create Database and Enable Extension

```sql
CREATE DATABASE sentrifugo;
\c sentrifugo

CREATE EXTENSION IF NOT EXISTS timescaledb;
```

### Verify the Extension

```sql
\dx timescaledb
```

Expected output:

```
                                      List of installed extensions
    Name     | Version |   Schema   |                            Description
-------------+---------+------------+-------------------------------------------------------------------
 timescaledb | 2.x.x   | public     | Enables scalable inserts and complex queries for time-series data
```

---

## Schema Created by the Application

The application automatically creates the following on startup (no manual SQL needed):

### Hypertable: `audit_logs`

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
    timestamp    TIMESTAMPTZ NOT NULL,
    module       TEXT        NOT NULL,
    actor_id     TEXT        NOT NULL,
    action       TEXT        NOT NULL,
    resource     TEXT        NOT NULL,
    debug_level  INT         NOT NULL,
    metadata     JSONB
);

SELECT create_hypertable('audit_logs', 'timestamp', if_not_exists => TRUE);
```

| Column        | Type           | Description                                  |
|---------------|----------------|----------------------------------------------|
| `timestamp`   | `TIMESTAMPTZ`  | Event time (hypertable partition key)        |
| `module`      | `TEXT`         | Application module name                      |
| `actor_id`    | `TEXT`         | User or service that triggered the event     |
| `action`      | `TEXT`         | Action performed                             |
| `resource`    | `TEXT`         | Target resource                              |
| `debug_level` | `INT`          | Severity / debug level                       |
| `metadata`    | `JSONB`        | Arbitrary structured payload                 |

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs (module, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor  ON audit_logs (actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_debug  ON audit_logs (debug_level, timestamp DESC);
```

All indexes are composite with `timestamp DESC` to optimize time-range queries filtered by module, actor, or debug level.

---

## Environment Configuration

Set the `TIMESCALEDB_DSN` in your `.env` file to point to your database:

```dotenv
TIMESCALEDB_DSN=postgresql://postgres:password@localhost:5432/sentrifugo
```

**DSN format:**

```
postgresql://<user>:<password>@<host>:<port>/<database>
```

| Component    | Default     | Description              |
|--------------|-------------|--------------------------|
| `user`       | `postgres`  | PostgreSQL username      |
| `password`   | `password`  | PostgreSQL password      |
| `host`       | `localhost` | Database server host     |
| `port`       | `5432`      | PostgreSQL port          |
| `database`   | `sentrifugo`| Database name            |

---

## Useful Commands

### Check TimescaleDB Version

```sql
SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';
```

### List Hypertables

```sql
SELECT * FROM timescaledb_information.hypertables;
```

### Check Chunk Sizes

```sql
SELECT * FROM timescaledb_information.chunks WHERE hypertable_name = 'audit_logs';
```

### Row Count

```sql
SELECT count(*) FROM audit_logs;
```

### Query Recent Logs

```sql
SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20;
```

### Disk Usage

```sql
SELECT hypertable_size('audit_logs');
```

---

## Troubleshooting

### `FATAL: extension "timescaledb" must be preloaded`

TimescaleDB must be listed in `shared_preload_libraries` in `postgresql.conf`.

Fix:

```bash
# Run the tuning tool
sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql
```

Or manually edit `postgresql.conf`:

```
shared_preload_libraries = 'timescaledb'
```

### `connection refused` on application startup

- Confirm PostgreSQL is running: `sudo systemctl status postgresql` or `docker ps`
- Confirm the port matches your `TIMESCALEDB_DSN`
- Check `pg_hba.conf` allows connections from `localhost` with `md5` or `scram-sha-256`

### `password authentication failed`

- Verify the credentials in your `.env` match the database user
- Reset the password if needed:

```sql
ALTER USER postgres WITH PASSWORD 'password';
```
