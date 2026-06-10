import { Request, Response, NextFunction } from 'express';

/**
 * requireSuiWallet — Adjustment 3 (G2 isolation guarantee).
 *
 * Mount on every route that creates or operates on Sui-native marketplace
 * products (workflows, skills, reflective traces). Returns 400 with a clear
 * "switch network" CTA when the request does not declare itself as Sui.
 *
 * Resolution order: header → body.chain → query.chain.
 *
 * Using a dedicated middleware (rather than per-route ad-hoc checks) keeps
 * the isolation boundary at one inspectable place — the canonical pattern
 * already used by `auth` and `agentKya` siblings.
 */
export const requireSuiWallet = (req: Request, res: Response, next: NextFunction) => {
  const headerChain = req.header('x-chain');
  const bodyChain = (req.body && (req.body as any).chain) as string | undefined;
  const queryChain = (req.query?.chain as string | undefined) ?? undefined;
  const chain = (headerChain ?? bodyChain ?? queryChain ?? '').toLowerCase();
  if (chain !== 'sui') {
    return res.status(400).json({
      error: 'sui-only-route',
      message:
        'This product type lives on Sui. Switch network in the top-bar pill, then retry.',
      cta: 'switch-network',
    });
  }
  next();
};
