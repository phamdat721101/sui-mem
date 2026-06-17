import { Request, Response, NextFunction } from 'express';

/**
 * Auth middleware — Sui wallet-address based.
 *
 * After the EVM/Fhenix pivot, identity is a single Sui wallet header
 * (`x-wallet-address`). All FHE permit ceremony is gone: payment is
 * proven per-call via the paymentGate / requireSuiWallet middlewares.
 *
 * SOLID:
 *  - SRP: this module only proves wallet identity. Per-route ownership
 *    + payment checks live in their own middlewares.
 *  - OCP: a public route opts out by appending one regex to PUBLIC_PATHS.
 */

export interface AuthRequest extends Request {
  user?: {
    address: string;
  };
}

const PUBLIC_PATHS: RegExp[] = [
  /^\/version$/,
  /^\/agents\/slug-available$/,
  /^\/agents\/top$/,
  /^\/agents\/search$/,
  /^(?:\/marketplace)?\/listings$/,
  /^(?:\/marketplace)?\/listings\/[^/]+$/,
  /^(?:\/marketplace)?\/agents\/[^/]+\/payment-info$/,
  /^(?:\/marketplace)?\/workflows$/,
  /^(?:\/marketplace)?\/workflows\/[^/]+$/,
  /^(?:\/marketplace)?\/workflows\/[^/]+\/recent$/,
  /^\/discover$/,
  /^\/brains\/[^/]+\/sovereignty-proof$/,
  /^\/brains\/[^/]+\/cost$/,
  /^\/[^/]+\/sovereignty-proof$/,
  /^\/dashboard\/stats$/,
  /^(?:\/memory)?\/marketplace$/,
  /^(?:\/memory)?\/brain\/[^/]+\/?$/,
  /^(?:\/memory)?\/brain\/[^/]+\/sovereignty-proof$/,
  // OpenX Loops public surface (mounted under /v3/loop).
  /^\/agents\/[^/]+$/,
  /^\/jobs\/[^/]+$/,
  /^\/concierge\/search$/,
];

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (PUBLIC_PATHS.some((re) => re.test(req.path))) return next();
  const address = req.headers['x-wallet-address'] as string | undefined;
  if (!address) return res.status(401).json({ error: 'Missing wallet address' });
  req.user = { address };
  next();
};
