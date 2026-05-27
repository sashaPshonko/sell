import { loadEnv } from '../lib/env.mjs';
import { assertPlayerokAuth } from '../lib/check-auth.mjs';

loadEnv();
await assertPlayerokAuth();
