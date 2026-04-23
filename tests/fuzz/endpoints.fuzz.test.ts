// Database — every query returns an empty result unless the app expects a stub row.
jest.mock("../../src/config/database", () => {
  const emptyResult = { rows: [], rowCount: 0, command: "", fields: [] };
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("SELECT id FROM roles WHERE name = $1")) {
      return Promise.resolve({ rows: [{ id: "role-user" }], rowCount: 1, command: "SELECT", fields: [] });
    }
    if (sql.includes("INSERT INTO users")) {
      return Promise.resolve({
        rows: [{
          id: "user-1",
          phone_number: "test-phone",
          kyc_level: "unverified",
          role_id: "role-user",
          two_factor_secret: null,
          backup_codes: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
        command: "INSERT",
        fields: [],
      });
    }
    if (sql.includes("COUNT(*)")) {
      return Promise.resolve({ rows: [{ count: "0" }], rowCount: 1, command: "SELECT", fields: [] });
    }
    return Promise.resolve(emptyResult);
  });
  return {
    pool: {
      query,
      connect: jest.fn().mockResolvedValue({ query, release: jest.fn() }),
    },
    queryRead: jest.fn().mockImplementation((sql: string) => Promise.resolve(sql.includes("COUNT(*)") ? { rows: [{ count: "0" }], rowCount: 1, command: "SELECT", fields: [] } : emptyResult)),
    queryWrite: jest.fn().mockResolvedValue(emptyResult),
    checkReplicaHealth: jest.fn().mockResolvedValue([]),
  };
});

jest.mock("../../src/config/redis", () => ({
  redisClient: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  connectRedis: jest.fn(),
  createRedisStore: jest.fn(() => ({})),
  SESSION_TTL_SECONDS: 3600,
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({}),
    close: jest.fn().mockResolvedValue(undefined),
    getFailedCount: jest.fn().mockResolvedValue(0),
    getJobCounts: jest.fn().mockResolvedValue({}),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Job: jest.fn(),
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  addTransactionJob: jest.fn(),
  getQueueStats: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0 }),
  pauseQueueEndpoint: jest.fn(),
  resumeQueueEndpoint: jest.fn(),
}));

jest.mock("../../src/services/kyc", () => {
  const mock = jest.fn().mockImplementation(() => ({
    createApplicant: jest.fn().mockResolvedValue({ id: "mock-applicant" }),
    getApplicant: jest.fn().mockResolvedValue(null),
    uploadDocument: jest.fn().mockResolvedValue({}),
    getVerificationStatus: jest.fn().mockResolvedValue("pending"),
    createWorkflowRun: jest.fn().mockResolvedValue({}),
    generateSDKToken: jest.fn().mockResolvedValue({ token: "mock-token" }),
  }));
  return {
    __esModule: true,
    default: mock,
    KYCLevel: { NONE: "none", BASIC: "basic", FULL: "full" },
    DocumentType: {
      PASSPORT: "passport",
      DRIVING_LICENSE: "driving_license",
      NATIONAL_IDENTITY_CARD: "national_identity_card",
      RESIDENCE_PERMIT: "residence_permit",
    },
  };
});

jest.mock("../../src/config/stellar", () => ({
  getStellarServer: jest.fn(() => ({ loadAccount: jest.fn() })),
  getNetworkPassphrase: jest.fn(() => "Test SDF Network ; September 2015"),
  validateStellarNetwork: jest.fn(),
  logStellarNetwork: jest.fn(),
  getSep24Config: jest.fn(() => ({
    webAuthDomain: "mobilemoney.com",
    interactiveUrlBase: "https://wallet.mobilemoney.com",
    signingKey: "GABCDE",
    issuerAccount: "GABCDE",
  })),
  getFeeBumpConfig: jest.fn(() => ({
    feePayerPublicKey: "",
    feePayerPrivateKey: "",
    maxFeePerTransaction: 100000,
    baseFeeStroops: 100,
    maxOperationsPerTransaction: 100,
  })),
  STELLAR_NETWORKS: { TESTNET: "testnet", MAINNET: "mainnet" },
}));

jest.mock("../../src/middleware/sentry", () => ({
  initSentry: jest.fn(),
  sentryBreadcrumbMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("express-session", () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock("../../src/tracer", () => {});

jest.mock("axios", () => {
  const instance = {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };
  const axiosMock = {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    create: jest.fn(() => instance),
    interceptors: instance.interceptors,
  };
  return {
    __esModule: true,
    default: axiosMock,
    ...axiosMock,
  };
});

const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

import request from "supertest";
import app from "../../src/index";

afterAll(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function isSafe(res: request.Response): boolean {
  if (res.status < 500) return true;
  const body = res.body as Record<string, unknown>;
  return (
    typeof body === "object" &&
    body !== null &&
    (typeof body.error === "string" ||
      typeof body.message === "string" ||
      typeof body.detail === "string")
  );
}

function qs(params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

const ATTACK_STRINGS = [
  "../../../etc/passwd",
  "' OR 1=1 --",
  "<script>alert(1)</script>",
  "%00",
  "{{7*7}}",
  "a".repeat(2048),
];

describe("Endpoint robustness smoke fuzz", () => {
  it("handles health, federation, and stellar.toml inputs without unhandled 500s", async () => {
    for (const value of ATTACK_STRINGS) {
      const responses = await Promise.all([
        request(app).get(`/health${qs({ foo: value, bar: value })}`),
        request(app).get(`/federation${qs({ q: value, type: "name" })}`),
        request(app).get("/.well-known/stellar.toml").set("If-None-Match", value),
      ]);
      expect(responses.every(isSafe)).toBe(true);
    }
  });

  it("handles transaction history query fuzz safely", async () => {
    const cases = [
      { offset: "-1", limit: "999999", startDate: "not-a-date", endDate: "tomorrow" },
      { offset: "abc", limit: "def", status: "DROP TABLE" },
      { startDate: "2026-01-01", endDate: "2025-01-01", provider: "<bad>" },
    ];

    for (const params of cases) {
      const responses = await Promise.all([
        request(app).get(`/api/transactions${qs(params)}`),
        request(app).get(`/api/v1/transactions${qs(params)}`),
      ]);
      expect(responses.every(isSafe)).toBe(true);
    }
  });

  it("handles malformed stellar address lookups safely", async () => {
    for (const address of ATTACK_STRINGS) {
      const res = await request(app).get(`/api/stellar/balance/${encodeURIComponent(address)}`);
      expect(isSafe(res)).toBe(true);
    }
  });

  it("handles malformed login requests safely", async () => {
    const bodies: unknown[] = [
      null,
      true,
      { phone_number: ATTACK_STRINGS[0] },
      { phone_number: { deeply: { nested: { value: "x" } } } },
      { phone_number: "A".repeat(10000) },
    ];

    for (const body of bodies) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send(body);
      expect(isSafe(res)).toBe(true);
    }
  });

  it("handles malformed authorization headers safely", async () => {
    const protectedRoutes = [
      { method: "get", path: "/api/v1/transactions" },
      { method: "get", path: "/api/contacts" },
      { method: "post", path: "/api/v1/transactions/deposit" },
    ] as const;

    for (const value of ATTACK_STRINGS) {
      const responses = await Promise.all(
        protectedRoutes.map(({ method, path }) =>
          (request(app) as any)[method](path).set("Authorization", `Bearer ${value}`),
        ),
      );
      expect(responses.every(isSafe)).toBe(true);
    }
  });

  it("handles SEP-12 and SEP-24 malformed inputs safely", async () => {
    const responses = await Promise.all([
      request(app).get(`/sep12/customer${qs({ account: ATTACK_STRINGS[1], memo: ATTACK_STRINGS[2], memo_type: ATTACK_STRINGS[3] })}`),
      request(app).put("/sep12/customer").send({ account: ATTACK_STRINGS[4], fields: ATTACK_STRINGS[5] }),
      request(app).get(`/sep24/info${qs({ lang: ATTACK_STRINGS[0] })}`),
    ]);
    expect(responses.every(isSafe)).toBe(true);
  });
});
