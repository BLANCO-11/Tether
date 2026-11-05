/** UAT lifecycle · read the LIVE Kestra flow for the UAT workspace. */
import { kestra } from "../services/kestra-client.service.js";
const NS = "foundry.default.uat-lifecycle";
const ID = "chase-tickets-past-their-resolve-target";
async function main() {
  const live: any = await kestra.getFlow({ value: NS } as never, ID);
  console.log("deployed:", !!live, "revision:", live?.revision);
  console.log("triggers:", JSON.stringify(live?.triggers ?? [], null, 2));
  console.log("inputs:", JSON.stringify(live?.inputs ?? [], null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
