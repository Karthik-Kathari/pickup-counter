import type { Pool } from 'pg';

/**
 * Idempotent seed: five snack products with stable, hard-coded UUIDs and a
 * stable `key` per product.
 *
 * Re-running the seed:
 * - inserts any product that is missing, and
 * - refreshes name/price for existing products, but
 * - NEVER touches stock_quantity, so re-seeding cannot silently reset
 *   inventory that real orders have consumed.
 *
 * Prices are integer paise everywhere (AGENTS.md I1).
 */

export interface SeedProduct {
  id: string;
  key: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
}

export const SEED_PRODUCTS: readonly SeedProduct[] = [
  {
    id: '3f8a91c2-7d15-4e6b-9a20-5c1e8b4d7f01',
    key: 'salted-potato-chips',
    name: 'Salted Potato Chips',
    pricePaise: 1500,
    stockQuantity: 50,
  },
  {
    id: '8c2d4f6a-1b39-47e8-a5d3-2e9f6c8b1a47',
    key: 'dark-chocolate-bar',
    name: 'Dark Chocolate Bar',
    pricePaise: 2500,
    stockQuantity: 40,
  },
  {
    id: 'd51e7b3c-9a24-4f10-8c6d-7b3e2a9f5c88',
    key: 'masala-peanuts',
    name: 'Masala Peanuts',
    pricePaise: 1200,
    stockQuantity: 60,
  },
  {
    id: '6a4c8e2f-3d71-4b95-9e0a-1f8c2d6b4a39',
    key: 'butter-cookies',
    name: 'Butter Cookies',
    pricePaise: 3000,
    stockQuantity: 35,
  },
  {
    id: 'b7f3d915-2c68-4a0e-8d4b-5e1a7c3f9b62',
    key: 'mango-juice-box',
    name: 'Mango Juice Box',
    pricePaise: 1800,
    stockQuantity: 45,
  },
];

export interface SeedResult {
  inserted: number;
  updated: number;
}

export async function runSeed(pool: Pool): Promise<SeedResult> {
  let inserted = 0;
  let updated = 0;

  for (const product of SEED_PRODUCTS) {
    const result = await pool.query<{ was_inserted: boolean }>(
      `
        INSERT INTO products (id, key, name, price_paise, stock_quantity)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE
          SET key = EXCLUDED.key,
              name = EXCLUDED.name,
              price_paise = EXCLUDED.price_paise,
              updated_at = now()
          -- stock_quantity intentionally NOT updated: re-seeding must not
          -- reset inventory consumed by real orders.
        RETURNING (xmax = 0) AS was_inserted
      `,
      [product.id, product.key, product.name, product.pricePaise, product.stockQuantity],
    );
    if (result.rows[0]?.was_inserted === true) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  return { inserted, updated };
}
