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

Optional:

```env
GROQ_API_KEY=
BRAVE_SEARCH_API_KEY=

SERPER_API_KEY=

EMAIL_HOST=
EMAIL_PORT=
EMAIL_USER=
EMAIL_PASS=
EMAIL_FROM=

APP_URL=http://localhost:3001

NODE_ENV=development
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

npm run build               # Production build

npm run start               # Start API

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