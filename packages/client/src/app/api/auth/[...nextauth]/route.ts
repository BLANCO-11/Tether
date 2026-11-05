// src/app/api/auth/[...nextauth]/route.ts — Auth.js request handlers (sign-in,
// callback, session, sign-out). All auth traffic flows through here.
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
