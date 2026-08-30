import { Router } from 'express';
import type Database from 'better-sqlite3';

export interface InsurancePoolStats {
  contractId: string;
  poolBalance: string;
  totalPremiumsCollected: string;
  totalClaimsPaid: string;
  enrolledLpCount: number;
  lastUpdatedAt: number;
}

export interface InsurancePoolEnrollmentStats {
  contractId: string;
  totalEnrollments: number;
  uniqueEnrolledLps: number;
  latestEnrollmentTimestamp: number | null;
}

export interface InsurancePoolClaimsStats {
  contractId: string;
  totalClaims: number;
  totalClaimedAmount: string;
  latestClaimTimestamp: number | null;
}

export function createInsuranceRouter(db: Database.Database): Router {
  const router = Router();

  /**
   * GET /insurance/pool/:contractId/stats
   * Returns current statistics for an insurance pool contract.
   */
  router.get('/insurance/pool/:contractId/stats', (req, res) => {
    const { contractId } = req.params;

    try {
      const stats = db
        .prepare('SELECT pool_balance, total_premiums_collected, total_claims_paid, enrolled_lp_count, last_updated_at FROM insurance_pool_stats WHERE contract_id = ?')
        .get(contractId) as
        | { pool_balance: string; total_premiums_collected: string; total_claims_paid: string; enrolled_lp_count: number; last_updated_at: number }
        | undefined;

      if (!stats) {
        res.status(404).json({ error: `No data found for contract ${contractId}` });
        return;
      }

      const result: InsurancePoolStats = {
        contractId,
        poolBalance: stats.pool_balance,
        totalPremiumsCollected: stats.total_premiums_collected,
        totalClaimsPaid: stats.total_claims_paid,
        enrolledLpCount: stats.enrolled_lp_count,
        lastUpdatedAt: stats.last_updated_at,
      };

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to fetch insurance pool stats: ${message}` });
    }
  });

  /**
   * GET /insurance/pool/:contractId/enrollments
   * Returns enrollment statistics for an insurance pool.
   */
  router.get('/insurance/pool/:contractId/enrollments', (req, res) => {
    const { contractId } = req.params;

    try {
      const totalEnrollments = db
        .prepare('SELECT COUNT(*) as count FROM insurance_pool_enrollments WHERE contract_id = ?')
        .get(contractId) as { count: number } | undefined;

      const uniqueEnrolled = db
        .prepare('SELECT COUNT(DISTINCT lp_address) as count FROM insurance_pool_enrollments WHERE contract_id = ?')
        .get(contractId) as { count: number } | undefined;

      const latestEnrollment = db
        .prepare('SELECT MAX(enrolled_at) as timestamp FROM insurance_pool_enrollments WHERE contract_id = ?')
        .get(contractId) as { timestamp: number | null } | undefined;

      const result: InsurancePoolEnrollmentStats = {
        contractId,
        totalEnrollments: totalEnrollments?.count ?? 0,
        uniqueEnrolledLps: uniqueEnrolled?.count ?? 0,
        latestEnrollmentTimestamp: latestEnrollment?.timestamp ?? null,
      };

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to fetch enrollment stats: ${message}` });
    }
  });

  /**
   * GET /insurance/pool/:contractId/claims
   * Returns claims statistics for an insurance pool.
   */
  router.get('/insurance/pool/:contractId/claims', (req, res) => {
    const { contractId } = req.params;

    try {
      const totalClaims = db
        .prepare('SELECT COUNT(*) as count FROM insurance_pool_claims WHERE contract_id = ?')
        .get(contractId) as { count: number } | undefined;

      const totalAmount = db
        .prepare('SELECT COALESCE(SUM(CAST(payout_amount AS INTEGER)), 0) as total FROM insurance_pool_claims WHERE contract_id = ?')
        .get(contractId) as { total: number } | undefined;

      const latestClaim = db
        .prepare('SELECT MAX(claimed_at) as timestamp FROM insurance_pool_claims WHERE contract_id = ?')
        .get(contractId) as { timestamp: number | null } | undefined;

      const result: InsurancePoolClaimsStats = {
        contractId,
        totalClaims: totalClaims?.count ?? 0,
        totalClaimedAmount: String(totalAmount?.total ?? '0'),
        latestClaimTimestamp: latestClaim?.timestamp ?? null,
      };

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to fetch claims stats: ${message}` });
    }
  });

  return router;
}
