import { Router } from 'express';
import type { Pool } from 'pg';

/**
 * GET /products — catalog with live availability.
 *
 * Availability formula (AGENTS.md I4), computed entirely in PostgreSQL:
 *
 *   available_units = GREATEST(stock_quantity − Σ(active held quantity), 0)
 *   active holds    = order_lines of orders in status 'pending' with
 *                     expires_at > now()   (database clock, I2)
 *
 * (`::int` cast: SUM() is bigint, which `pg` would return as a string.)
 *
 * Expired holds never reduce availability — the formula excludes them
 * regardless of whether their order's status row has been flipped to
 * 'expired' yet (the lazy flip only materializes what the formula already
 * ignores; see src/orders/lifecycle.ts).
 *
 * A single SELECT runs under READ COMMITTED with no locks: each statement
 * gets one consistent snapshot, so a response is internally consistent even
 * while other transactions create orders; the next request sees their
 * commits. GREATEST(...) guarantees availability is never negative.
 */

const PRODUCTS_QUERY = `
  SELECT p.id,
         p.name,
         p.price_paise,
         p.stock_quantity,
         GREATEST(
           p.stock_quantity - COALESCE(held.held_quantity, 0),
           0
         )::int AS available_units
    FROM products p
    LEFT JOIN (
      SELECT ol.product_id, SUM(ol.quantity) AS held_quantity
        FROM order_lines ol
        JOIN orders o ON o.id = ol.order_id
       WHERE o.status = 'pending'
         AND o.expires_at > now()
       GROUP BY ol.product_id
    ) held ON held.product_id = p.id
   ORDER BY p.name, p.id
`;

export interface ProductResponse {
  id: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
  availableUnits: number;
}

interface ProductRow {
  id: string;
  name: string;
  price_paise: string;
  stock_quantity: number;
  available_units: number;
}

/**
 * Map a DB row to the public JSON shape. `price_paise` is BIGINT and comes
 * back from `pg` as a string; it is converted once, here, at the HTTP
 * boundary. Values are bounded (positive price, finite stock), so the
 * conversion is exact for this domain; money arithmetic itself never happens
 * in JavaScript — totals are computed in SQL (I1).
 */
export function toProductResponse(row: ProductRow): ProductResponse {
  return {
    id: row.id,
    name: row.name,
    pricePaise: Number(row.price_paise),
    stockQuantity: row.stock_quantity,
    availableUnits: row.available_units,
  };
}

export async function listProducts(pool: Pool): Promise<ProductResponse[]> {
  const result = await pool.query<ProductRow>(PRODUCTS_QUERY);
  return result.rows.map(toProductResponse);
}

export function createProductsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/products', async (_req, res, next) => {
    try {
      const products = await listProducts(pool);
      res.json({ products });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
