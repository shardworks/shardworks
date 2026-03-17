import { createPool } from '@shardworks/db';

export const pool = createPool({ connectionLimit: 5 });
