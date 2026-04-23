import request from "supertest";
import express from "express";
import feesRouter from "../../src/routes/fees";
import { feeService } from "../../src/services/feeService";

jest.mock("../../src/services/feeService", () => ({
  feeService: {
    calculateFee: jest.fn(),
    getActiveConfiguration: jest.fn(),
  },
}));

const mockFeeService = feeService as jest.Mocked<typeof feeService>;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/fees", feesRouter);
  return app;
}

describe("Fees API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/fees/calculate", () => {
    it("should calculate fee using fallback when service fails", async () => {
      mockFeeService.calculateFee.mockResolvedValue({
        fee: 150,
        total: 10150,
        configUsed: "env_fallback",
      });

      const response = await request(createApp())
        .post("/api/fees/calculate")
        .send({ amount: 10000 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.fee).toBe(150);
      expect(response.body.data.total).toBe(10150);
      expect(response.body.data.configUsed).toBe('env_fallback');
    });

    it("should return validation error for invalid amount", async () => {
      const response = await request(createApp())
        .post("/api/fees/calculate")
        .send({ amount: -100 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("GET /api/fees/configurations/active", () => {
    it("should return error when no active configuration found", async () => {
      mockFeeService.getActiveConfiguration.mockRejectedValueOnce(
        new Error("No active fee configuration found"),
      );

      const response = await request(createApp())
        .get("/api/fees/configurations/active");

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });
});
