# AI Companies Intelligence — API

Backend API for the AI Companies Intelligence platform. The service crawls company websites, extracts structured business data and provides a REST API for authentication, uploads, enrichment and exports.

> The frontend is available in a separate repository:
> https://github.com/EmilyStoyanova/-ai-first-companies-intelligence-fe

---

## Live Demo

**Frontend**

https://ai-first-companies-intelligence-fe.onrender.com

**Backend API**

https://ai-first-companies-intelligence-api.onrender.com

**Swagger UI**

https://ai-first-companies-intelligence-api.onrender.com/docs

---

## Technology Stack

| Layer | Technology |
|--------|------------|
| Runtime | Node.js + TypeScript |
| API | Express.js |
| ORM | Prisma |
| Database | PostgreSQL (Neon) |
| Queue | pg-boss |
| Crawling | Crawlee (CheerioCrawler + Playwright fallback) |
| AI | Groq |
| Search | Brave Search API |
| Authentication | JWT |
| Documentation | Swagger UI |
| Email | Nodemailer |

---

# Local Development

## 1. Install dependencies

```bash
npm install
```

---

## 2. Configure the environment

Copy the example file:

```bash
cp .env.example .env
```

Configure your environment variables.

Minimum required:

```env
DATABASE_URL=
JWT_SECRET=
```

Optional (see `.env.example` for hybrid Vercel + Mac notes):

```env
QUEUE_DATABASE_URL=
GROQ_API_KEY=
BRAVE_SEARCH_API_KEY=
FRONTEND_URL=http://localhost:3000
APP_URL=http://localhost:3001
STORAGE_BASE_PATH=./storage
WORKER_CONCURRENCY=5
```

Generate a secure JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## 3. Configure the database

Generate Prisma Client:

```bash
npm run db:generate
```

Run migrations:

```bash
npm run db:migrate
```

---

## 4. Start the application

```bash
npm run dev
```

This starts:

- Express API
- Background Worker

The API is available at

```
http://localhost:3001
```

Swagger UI

```
http://localhost:3001/docs
```

The frontend runs separately on

```
http://localhost:3000
```

---

# Production

Frontend

https://ai-first-companies-intelligence-fe.onrender.com

Backend

https://ai-first-companies-intelligence-api.onrender.com

Swagger

https://ai-first-companies-intelligence-api.onrender.com/docs

---

# Hybrid deploy (Vercel API + Mac worker)

The HTTP API can run on **Vercel Hobby** while crawl, persona discovery, and personalization run on an always-on machine (e.g. your Mac). Same GitHub repo — no separate worker project.

```
Browser / Frontend  →  Vercel (Express)  →  Neon (Prisma + pg-boss jobs)
                                              ↑
                         Mac: npm run start:worker (Playwright, Groq, Brave)
```

## Vercel (API only)

1. Import this repository into a Vercel project.
2. Set environment variables:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Neon **pooler** URL |
| `QUEUE_DATABASE_URL` | Neon **direct** URL (no `-pooler`) for pg-boss |
| `JWT_SECRET` | Same secret as local / frontend expectations |
| `FRONTEND_URL` | Exact frontend origin (CORS) |
| `APP_URL` | Public API origin (email confirmation links) |
| `STORAGE_BASE_PATH` | `/tmp/storage` |
| `BREVO_API_KEY` / `EMAIL_FROM` | Verification emails |
| `ENABLE_EMBEDDED_WORKER` | **Do not set** |

`vercel.json` already skips Playwright browser download and builds with Prisma + Swagger + `tsc`. The entry is `api/index.ts`, which exports Express without importing the worker.

3. After deploy, check `GET /health` (includes pending queue sizes) and `/docs`.

## Mac (worker)

Clone **this same repository** on the Mac:

```bash
git clone <this-repo-url>
cd ai-first-companies-intelligence-api
npm ci
npx prisma generate
npx playwright install chromium
cp .env.example .env   # then edit
npm run build
npm run start:worker
```

Worker `.env` essentials:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Same Neon DB (direct or pooler for Prisma) |
| `QUEUE_DATABASE_URL` | Neon **direct** (recommended; same as Vercel) |
| `GROQ_API_KEY` | Crawl enrichment / personalization / campaign email |
| `BRAVE_SEARCH_API_KEY` | Persona discovery |
| `WORKER_CONCURRENCY` | e.g. `5` |
| `ENABLE_EMBEDDED_WORKER` | **Do not set** |

No inbound ports or public URL are required. The worker polls Neon for pg-boss jobs enqueued by the Vercel API.

### Keep the worker running

- **pm2:** `pm2 start dist/worker/index.js --name ci-worker` then `pm2 save` / `pm2 startup`
- **launchd:** a LaunchAgent that runs `node dist/worker/index.js` with `WorkingDirectory` set to the repo and `KeepAlive` true
- Prevent sleep: System Settings → Energy → prevent automatic sleeping, or `caffeinate -dims &`

If the Mac is offline, jobs remain in Neon and batches stay `PROCESSING` until the worker starts again.

## Frontend

Point the frontend at the Vercel API:

```env
NEXT_PUBLIC_API_URL=https://<your-api>.vercel.app
```

Do not rely on the local `next.config.ts` rewrite to `localhost:3001` for production.

---

# Main Features

- JWT authentication
- Email confirmation
- Multi-tenant architecture
- Company website crawling
- Persona-based company discovery
- CSV/XLSX upload
- CSV/XLSX export
- Background processing with pg-boss
- AI-assisted company filtering
- Swagger API documentation

---

# API Endpoints

All endpoints except `/api/auth/*` require

```
Authorization: Bearer <token>
```

| Method | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/confirm-email` | Confirm email |
| POST | `/api/batches/upload` | Upload CSV/XLSX |
| GET | `/api/batches` | List batches |
| GET | `/api/batches/:id` | Batch details |
| GET | `/api/batches/:id/companies` | Companies |
| GET | `/api/batches/:id/download` | Export |
| DELETE | `/api/batches/:id` | Delete batch |
| GET | `/api/companies/:domain` | Company profile |
| POST | `/api/persona-searches` | Persona search |

---

# Upload Format

Example CSV

```csv
domain
google.com
github.com
stripe.com
```

Domains are normalized automatically.

---

# Scripts

```bash
npm run dev                 # API + Worker
npm run dev:worker          # Worker only

npm run build               # Swagger + production build
npm run build:swagger       # Regenerate OpenAPI JSON

npm run start               # Start API
npm run start:worker        # Start worker (Mac / Docker companion)

npm run db:generate         # Prisma Client
npm run db:migrate          # Prisma migrations
npm run db:push             # Push schema
npm run db:studio           # Prisma Studio

npm test
```

---

# Multi-Tenancy

Each user belongs to a tenant.

All uploaded batches, discovered companies, exports and settings are isolated per tenant.