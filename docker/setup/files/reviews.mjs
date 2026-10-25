import { randomBytes } from 'node:crypto';
import { fail } from './paths.mjs';

/** Reviews never survive a restart. A consumed, expired or unknown token always
 * needs a new preview; retries cannot replay a destructive operation. */
export function createReviews({now=Date.now,ttl=5*60_000,max=64}={}) {
  const records=new Map();
  const prune=()=>{for(const [token,row]of records)if(now()-row.at>=ttl)records.delete(token);};
  const issue=(kind,facts)=>{prune();if(records.size>=max)records.delete(records.keys().next().value);const token=randomBytes(32).toString('hex');records.set(token,{kind,facts,at:now()});return {token,expiresAt:new Date(now()+ttl).toISOString()};};
  const peek=(token,kind)=>{prune();const row=typeof token==='string'&&records.get(token);if(!row||row.kind!==kind)fail('stale','This review expired or was already used. Review the current files again.');return row.facts;};
  const consume=(token,kind)=>{const facts=peek(token,kind);records.delete(token);return facts;};
  return {issue,peek,consume};
}
