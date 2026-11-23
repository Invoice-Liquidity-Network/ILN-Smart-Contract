// Single source of truth lives in ../db/schema.ts. This module used to hold a
// second, drifted copy of the DDL (its own index list referenced columns its
// tables did not have, so it threw on first use). Re-export instead.
export { initializeSchema } from '../db/schema.js';
