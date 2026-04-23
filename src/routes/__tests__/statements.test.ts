import request from "supertest";
import express from "express";

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === "Bearer test-token") {
      req.user = { id: "test-user-id" } as any;
    }
    next();
  },
}));

jest.mock("../../config/database", () => ({
  pool: {
    connect: jest.fn(),
  },
}));

jest.mock("../../utils/encryption", () => ({
  decrypt: jest.fn((value: string) => value),
}));

import { statementsRoutes } from "../statements";
import { pool } from "../../config/database";

describe("Statements Routes", () => {
  let app: express.Application;
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };

  beforeEach(() => {
    app = express();
    app.use("/api/statements", statementsRoutes);
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);
    mockClient.query.mockReset();
    mockClient.release.mockReset();
  });

  describe("GET /api/statements/monthly/:year/:month", () => {
    it("should require authentication", async () => {
      const response = await request(app)
        .get("/api/statements/monthly/2024/01")
        .expect(401);

      expect(response.body.error).toBe("User not authenticated");
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it("should validate year and month parameters", async () => {
      const response = await request(app)
        .get("/api/statements/monthly/invalid/month")
        .set("Authorization", "Bearer test-token")
        .expect(400);

      expect(response.body.error).toBe("Invalid year or month");
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it("should generate an empty PDF statement when no transactions are found", async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: "test-user-id", phone_number: "1234567890", kyc_level: "basic" }],
      });
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      mockClient.query.mockResolvedValueOnce({ rows: [{ opening_balance: "0" }] });

      const response = await request(app)
        .get("/api/statements/monthly/2024/01")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["content-disposition"]).toContain("statement-2024-01.pdf");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should generate PDF statement when data exists", async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: "test-user-id", phone_number: "1234567890", kyc_level: "basic" }],
      });
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: "tx-1",
            referenceNumber: "TEST123",
            type: "deposit",
            amount: "100.00",
            currency: "USD",
            provider: "test-provider",
            status: "completed",
            notes: "note",
            createdAt: new Date("2024-01-15T00:00:00.000Z"),
          },
        ],
      });
      mockClient.query.mockResolvedValueOnce({ rows: [{ opening_balance: "0" }] });

      const response = await request(app)
        .get("/api/statements/monthly/2024/01")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["content-disposition"]).toContain("statement-2024-01.pdf");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
