import { redirect } from 'next/navigation';

/**
 * /train — superseded by per-agent training under /studio/agent/[slug]/train.
 * Generic memwal writes were folded into the agent-specific surface so each
 * action lands in the right namespace + history feed automatically.
 */
export default function TrainRedirect(): never {
  redirect('/studio');
}
