let registeredProcessor:
  | ((data: Record<string, unknown>, msg: unknown) => Promise<void>)
  | undefined;

const mockPublish = jest.fn();

jest.mock("../../src/queue/rabbitmq", () => ({
  EXCHANGES: { TRANSACTIONS: "transactions.topic" },
  ROUTING_KEYS: {
    TRANSACTION_PROCESS: "transaction.process",
    TRANSACTION_COMPLETED: "transaction.completed",
    TRANSACTION_FAILED: "transaction.failed",
  },
  QUEUES: {
    TRANSACTION_PROCESSING: "transaction-processing-queue",
  },
  rabbitMQManager: {
    consume: jest.fn().mockImplementation(
      async (
        _queue: string,
        processor: (data: Record<string, unknown>, msg: unknown) => Promise<void>,
      ) => {
        registeredProcessor = processor;
      },
    ),
    publish: (...args: unknown[]) => mockPublish(...args),
  },
}));

const mockTransactionModel = {
  updateStatus: jest.fn(),
  findById: jest.fn(),
  updateWebhookDelivery: jest.fn(),
  patchMetadata: jest.fn(),
  incrementRetryCount: jest.fn(),
};

const mockMobileMoneyService = {
  initiatePayment: jest.fn(),
  sendPayout: jest.fn(),
};

const mockStellarService = {
  sendPayment: jest.fn(),
};

const mockNotifyTransactionWebhook = jest.fn();

jest.mock("../../src/models/transaction", () => {
  const actual = jest.requireActual("../../src/models/transaction");
  return {
    ...actual,
    TransactionModel: jest.fn().mockImplementation(() => mockTransactionModel),
  };
});

jest.mock("../../src/services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => mockMobileMoneyService),
}));

jest.mock("../../src/services/stellar/stellarService", () => ({
  StellarService: jest.fn().mockImplementation(() => mockStellarService),
}));

jest.mock("../../src/services/webhook", () => ({
  WebhookService: jest.fn().mockImplementation(() => ({})),
  notifyTransactionWebhook: (...args: unknown[]) => mockNotifyTransactionWebhook(...args),
}));

function loadWorker() {
  jest.isolateModules(() => {
    require("../../src/queue/worker");
  });
}

function getTransactionStatus() {
  return require("../../src/models/transaction").TransactionStatus;
}

function getProcessor() {
  expect(registeredProcessor).toBeDefined();
  return registeredProcessor!;
}

function buildData(dataOverrides: Record<string, unknown> = {}) {
  return {
    transactionId: "txn-1",
    type: "deposit",
    amount: "10000",
    phoneNumber: "+237670000000",
    provider: "mtn",
    stellarAddress: `G${"A".repeat(55)}`,
    ...dataOverrides,
  };
}

describe("transaction worker webhook integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    registeredProcessor = undefined;
    mockMobileMoneyService.initiatePayment.mockResolvedValue({ success: true });
    mockMobileMoneyService.sendPayout.mockResolvedValue({ success: true });
    mockStellarService.sendPayment.mockResolvedValue(undefined);
    mockNotifyTransactionWebhook.mockResolvedValue({
      status: "delivered",
    });
    mockTransactionModel.findById.mockResolvedValue(null);
    loadWorker();
  });

  it("sends a completed webhook after a successful deposit", async () => {
    const TransactionStatus = getTransactionStatus();
    const processor = getProcessor();
    const data = buildData();

    await processor(data, {});

    expect(mockTransactionModel.updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Completed,
    );
    expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
      "txn-1",
      "transaction.completed",
      expect.objectContaining({
        transactionModel: mockTransactionModel,
      }),
    );
  });

  it("sends a failed webhook when transaction processing throws", async () => {
    const TransactionStatus = getTransactionStatus();
    const processor = getProcessor();
    const data = buildData();

    mockMobileMoneyService.initiatePayment.mockResolvedValue({
      success: false,
      error: "provider outage",
    });

    await processor(data, {});

    expect(mockTransactionModel.updateStatus).toHaveBeenCalledWith(
      "txn-1",
      TransactionStatus.Failed,
    );
    expect(mockNotifyTransactionWebhook).toHaveBeenCalledWith(
      "txn-1",
      "transaction.failed",
      expect.objectContaining({
        transactionModel: mockTransactionModel,
      }),
    );
  });
});
