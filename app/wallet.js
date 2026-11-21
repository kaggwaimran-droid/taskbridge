const express = require('express');

module.exports = function walletRouter(pool) {
  const router = express.Router();

  // Schema only: no customer money is credited or moved by this module.
  // Provider deposits and payouts stay disabled until a licensed partner has
  // approved the custody/marketplace arrangement and its signed API/webhooks
  // have been configured.
  const schema = () => pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_accounts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      currency VARCHAR(3) NOT NULL,
      available_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
      reserved_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, currency)
    );
    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      currency VARCHAR(3) NOT NULL,
      entry_type TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      provider TEXT,
      provider_event_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, provider_event_id)
    );
    CREATE INDEX IF NOT EXISTS wallet_ledger_user_idx
      ON wallet_ledger(user_id, currency, created_at DESC);
    CREATE TABLE IF NOT EXISTS task_funding_reservations (
      id BIGSERIAL PRIMARY KEY,
      task_id BIGINT NOT NULL UNIQUE REFERENCES tasks(id),
      client_id BIGINT NOT NULL REFERENCES users(id),
      currency VARCHAR(3) NOT NULL,
      total_amount NUMERIC(14,2) NOT NULL CHECK (total_amount > 0),
      remaining_amount NUMERIC(14,2) NOT NULL CHECK (remaining_amount >= 0),
      status TEXT NOT NULL DEFAULT 'pending_partner_approval',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS task_funding_client_idx
      ON task_funding_reservations(client_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS task_wallet_releases (
      id BIGSERIAL PRIMARY KEY,
      submission_id BIGINT NOT NULL UNIQUE REFERENCES task_submissions(id),
      reservation_id BIGINT NOT NULL REFERENCES task_funding_reservations(id),
      task_id BIGINT NOT NULL REFERENCES tasks(id),
      client_id BIGINT NOT NULL REFERENCES users(id),
      worker_id BIGINT NOT NULL REFERENCES users(id),
      currency VARCHAR(3) NOT NULL,
      gross_amount NUMERIC(14,2) NOT NULL CHECK (gross_amount > 0),
      platform_fee NUMERIC(14,2) NOT NULL CHECK (platform_fee >= 0),
      worker_net NUMERIC(14,2) NOT NULL CHECK (worker_net >= 0),
      status TEXT NOT NULL DEFAULT 'pending_partner_approval',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at TIMESTAMPTZ
    );
  `);

  router.use(async (req, res, next) => {
    try {
      await schema();
      next();
    } catch (error) {
      next(error);
    }
  });

  async function auth(req, res, next) {
    try {
      if (!req.session.userId) return res.status(401).json({ error: 'Please sign in.' });
      req.walletUser = (await pool.query(
        'SELECT id FROM users WHERE id = $1',
        [req.session.userId]
      )).rows[0] || null;
      if (!req.walletUser) return res.status(401).json({ error: 'Please sign in.' });
      next();
    } catch (error) {
      next(error);
    }
  }

  router.get('/wallet/summary', auth, async (req, res, next) => {
    try {
      const [accounts, reservations, history] = await Promise.all([
        pool.query(
          'SELECT currency, available_balance, reserved_balance FROM wallet_accounts WHERE user_id = $1 ORDER BY currency',
          [req.walletUser.id]
        ),
        pool.query(
          `SELECT currency, COALESCE(SUM(remaining_amount), 0)::numeric AS total
           FROM task_funding_reservations
           WHERE client_id = $1 AND status IN ('reserved', 'partially_released')
           GROUP BY currency`,
          [req.walletUser.id]
        ),
        pool.query(
          `SELECT entry_type, amount, currency, reference_type, reference_id, description, created_at
           FROM wallet_ledger WHERE user_id = $1
           ORDER BY created_at DESC LIMIT 30`,
          [req.walletUser.id]
        )
      ]);
      res.json({
        wallet_enabled: process.env.TASK_WALLET_ENFORCED === 'true',
        deposits_enabled: false,
        payouts_enabled: false,
        balances: accounts.rows.map(row => ({
          currency: row.currency,
          available: Number(row.available_balance),
          reserved: Number(row.reserved_balance)
        })),
        active_task_reservations: reservations.rows.map(row => ({
          currency: row.currency,
          remaining: Number(row.total)
        })),
        history: history.rows
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
