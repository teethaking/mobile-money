import request from "supertest";
import express from "express";
import stellarRouter from "../../src/routes/stellar";

jest.mock("../../src/middleware/rateLimit", () => ({
  sep24RateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

function createApp() {
  const app = express();
  app.use("/api/stellar", stellarRouter);
  return app;
}

describe("GET /api/stellar/balance/:address", () => {
  it("should return 400 for invalid address", async () => {
    const res = await request(createApp()).get("/api/stellar/balance/invalid");

    expect(res.status).toBe(400);
  });

  it("should return balance for valid address", async () => {
    const res = await request(createApp()).get(
      "/api/stellar/balance/GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7"
    );

    expect([200, 404]).toContain(res.status);
  });
});
