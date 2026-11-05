import 'server-only';

import { createAuth } from '@fc/api';
import { headers } from 'next/headers';
import { cache } from 'react';
import { getServerDb } from './server-db';

export const getServerSession = cache(async () => {
  const auth = createAuth(getServerDb(), process.env.NEXT_PUBLIC_APP_URL);
  return auth.api.getSession({ headers: await headers() });
});
