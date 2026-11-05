/** The three generic domains, in the order they are seeded. */
import { HIRING_DOMAIN } from "./hiring.js";
import { ORDERS_DOMAIN } from "./orders.js";
import { SUPPORT_DOMAIN } from "./support.js";
import type { DomainSpec } from "./domain.js";

export const GENERIC_DOMAINS: DomainSpec[] = [SUPPORT_DOMAIN, ORDERS_DOMAIN, HIRING_DOMAIN];
export { SUPPORT_DOMAIN, ORDERS_DOMAIN, HIRING_DOMAIN };
export type { DomainSpec };
