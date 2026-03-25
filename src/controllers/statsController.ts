import { Request, Response } from "express";
import { StatsService } from "../services/statsService";
import { redisClient } from "../config/redis";

const statsService = new StatsService();
const CACHE_TTL = 15 * 60; // 15 minutes in seconds

export class StatsController {
  /**
   * GET /api/stats
   * Get system-wide statistics and metrics
   */
  static async getStats(req: Request, res: Response) {
    try {
      const { startDate, endDate } = req.query;

      const start = startDate ? new Date(startDate as string) : undefined;
      const end = endDate ? new Date(endDate as string) : undefined;

      // Validate dates
      if (startDate && isNaN(start!.getTime())) {
        return res.status(400).json({ error: "Invalid startDate format" });
      }
      if (endDate && isNaN(end!.getTime())) {
        return res.status(400).json({ error: "Invalid endDate format" });
      }

      // Generate cache key based on filters
      const cacheKey = `stats:full:${startDate || "all"}:${endDate || "all"}`;

      // Check cache
      if (redisClient?.isOpen) {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json(JSON.parse(cachedData));
        }
      }

      // Fetch stats from service
      const [general, byProvider, activeUsers, trends] = await Promise.all([
        statsService.getGeneralStats(start, end),
        statsService.getVolumeByProvider(start, end),
        statsService.getActiveUsersCount(start, end),
        statsService.getVolumeByPeriod("day", start, end),
      ]);

      const response = {
        totalTransactions: general.totalTransactions,
        successRate: parseFloat(general.successRate.toFixed(2)),
        totalVolume: general.totalVolume,
        averageAmount: parseFloat(general.averageAmount.toFixed(2)),
        activeUsers,
        byProvider,
        trends,
        timestamp: new Date().toISOString(),
        cached: false,
      };

      // Store in cache
      if (redisClient?.isOpen) {
        await redisClient.setEx(
          cacheKey,
          CACHE_TTL,
          JSON.stringify({ ...response, cached: true }),
        );
      }

      return res.json(response);
    } catch (error) {
      console.error("Error fetching stats:", error);
      return res
        .status(500)
        .json({
          error: "Internal server error",
          message: "Failed to calculate statistics",
        });
    }
  }
}
