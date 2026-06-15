import { redirect } from 'next/navigation';

/**
 * /loop — superseded by /marketplace (single discovery surface, loop-first).
 *
 * The Loops product is now the dominant primitive on /marketplace via
 * ConciergeChat. Deep links to /loop/agent/[id], /loop/job/[objectId],
 * /loop/seller/onboard remain alive — only the landing redirects.
 */
export default function LoopLandingRedirect(): never {
  redirect('/marketplace');
}
