# TaskBridge MVP

TaskBridge is a separate full-stack MVP; the original marketing homepage remains at the repository root.

## Deploy with Render + Neon

1. Create a PostgreSQL project at https://neon.com/ and copy its connection string. Keep it private.
2. In Render, create a new Blueprint using this repository and its root `render.yaml` file.
3. Enter the Neon connection string for `DATABASE_URL` and your email for `ADMIN_EMAIL`. Render generates `SESSION_SECRET`.
4. Deploy. The backend creates database tables at startup. Test `/api/health`, registration, logout and login.
5. The Render URL serves the homepage at `/`; `/marketplace` serves the marketplace app.

## Important

- Never commit database credentials to GitHub or share them in chat.
- The website is not live until Render deployment succeeds and environment variables are configured.
- GitHub Pages cannot run this backend. Use the Render URL for the first live version.
- Sample listings are illustrative. Payments, escrow, email verification, password reset, identity verification, messaging, dispute resolution and full fraud controls are not implemented. Do not accept payments or promise protected payouts yet.
