import { createServer } from "http";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { WebSocketManager } from "../src/websocket";

jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
    subscribe: jest.fn(async () => undefined),
    unsubscribe: jest.fn(async () => undefined),
    publish: jest.fn(async () => 0),
  })),
}));

const TEST_SECRET = "test-jwt-secret";
const TEST_PORT = 9877;

function makeToken(payload: object = { userId: "user-1", email: "u@test.com" }) {
  return jwt.sign(payload, TEST_SECRET, { expiresIn: "1h" });
}

function waitForMessage(ws: WebSocket): Promise<object> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reasonBuf) =>
      resolve({ code, reason: reasonBuf.toString() }),
    );
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = waitForClose(ws);
  if (ws.readyState !== WebSocket.CLOSING) {
    ws.close();
  }
  await closed;
}

describe("WebSocketManager", () => {
  let manager: WebSocketManager;
  let baseUrl: string;
  let httpServer: ReturnType<typeof createServer>;

  beforeAll((done) => {
    process.env.JWT_SECRET = TEST_SECRET;
    httpServer = createServer();
    manager = new WebSocketManager(httpServer);
    httpServer.listen(TEST_PORT, done);
    baseUrl = `ws://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    void manager.close();
    httpServer.closeAllConnections?.();
    httpServer.close();
  }, 5_000);

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe("authentication", () => {
    it("rejects connections with no token", async () => {
      const ws = new WebSocket(baseUrl);
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it("rejects connections with an invalid token", async () => {
      const ws = new WebSocket(`${baseUrl}?token=not-a-valid-jwt`);
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it("accepts connections with a valid Bearer token", async () => {
      const token = makeToken();
      const ws = new WebSocket(baseUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const msg = (await waitForMessage(ws)) as { type: string; data: { userId: string } };
      expect(msg.type).toBe("connection.ack");
      expect(msg.data.userId).toBe("user-1");
      await closeWs(ws);
    });

    it("accepts connections with a valid ?token= query parameter", async () => {
      const token = makeToken();
      const ws = new WebSocket(`${baseUrl}?token=${token}`);
      const msg = (await waitForMessage(ws)) as { type: string };
      expect(msg.type).toBe("connection.ack");
      await closeWs(ws);
    });

    it("falls back to sub claim when userId is absent", async () => {
      const token = makeToken({ sub: "sub-user-99", email: "s@test.com" });
      const ws = new WebSocket(`${baseUrl}?token=${token}`);
      const msg = (await waitForMessage(ws)) as { type: string; data: { userId: string } };
      expect(msg.type).toBe("connection.ack");
      expect(msg.data.userId).toBe("sub-user-99");
      await closeWs(ws);
    });
  });

  // ---------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // ---------------------------------------------------------------------------

  describe("subscribe / unsubscribe", () => {
    it("acknowledges a valid subscribe message", async () => {
      const ws = new WebSocket(`${baseUrl}?token=${makeToken()}`);
      await waitForMessage(ws); // connection.ack

      ws.send(
        JSON.stringify({ type: "subscribe", data: { transactionId: "tx-abc" } }),
      );
      const ack = (await waitForMessage(ws)) as { type: string; data: { transactionId: string } };
      expect(ack.type).toBe("subscribe.ack");
      expect(ack.data.transactionId).toBe("tx-abc");
      await closeWs(ws);
    });

    it("returns an error for unknown message types", async () => {
      const ws = new WebSocket(`${baseUrl}?token=${makeToken()}`);
      await waitForMessage(ws); // connection.ack

      ws.send(JSON.stringify({ type: "unknown.type", data: {} }));
      const err = (await waitForMessage(ws)) as { type: string; data: { message: string } };
      expect(err.type).toBe("error");
      expect(err.data.message).toMatch(/unknown message type/i);
      await closeWs(ws);
    });

    it("returns an error for malformed JSON", async () => {
      const ws = new WebSocket(`${baseUrl}?token=${makeToken()}`);
      await waitForMessage(ws); // connection.ack

      ws.send("this is not json");
      const err = (await waitForMessage(ws)) as { type: string; data: { message: string } };
      expect(err.type).toBe("error");
      expect(err.data.message).toMatch(/invalid json/i);
      await closeWs(ws);
    });
  });

  // ---------------------------------------------------------------------------
  // Broadcasting
  // ---------------------------------------------------------------------------

  describe("broadcastTransactionUpdate", () => {
    it("delivers a status update to subscribed clients", async () => {
      const ws = new WebSocket(`${baseUrl}?token=${makeToken()}`);
      await waitForMessage(ws); // connection.ack

      ws.send(
        JSON.stringify({ type: "subscribe", data: { transactionId: "tx-broadcast-1" } }),
      );
      await waitForMessage(ws); // subscribe.ack

      const broadcastPromise = waitForMessage(ws);
      await manager.broadcastTransactionUpdate({
        id: "tx-broadcast-1",
        status: "completed",
      });
      const update = (await broadcastPromise) as { type: string; data: { id: string; status: string } };
      expect(update.type).toBe("transaction.updated");
      expect(update.data.id).toBe("tx-broadcast-1");
      expect(update.data.status).toBe("completed");
      await closeWs(ws);
    });

    it("does not deliver updates to unsubscribed clients", async () => {
      const ws = new WebSocket(`${baseUrl}?token=${makeToken()}`);
      await waitForMessage(ws); // connection.ack

      // Subscribe to a different transaction
      ws.send(
        JSON.stringify({ type: "subscribe", data: { transactionId: "tx-other" } }),
      );
      await waitForMessage(ws); // subscribe.ack

      const received: unknown[] = [];
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });

      await manager.broadcastTransactionUpdate({
        id: "tx-not-subscribed",
        status: "failed",
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(received).toHaveLength(0);
      await closeWs(ws);
    });

    it("stops delivering updates after unsubscribe", async () => {
      const ws = new WebSocket(`${baseUrl}?token=${makeToken()}`);
      await waitForMessage(ws); // connection.ack

      ws.send(
        JSON.stringify({ type: "subscribe", data: { transactionId: "tx-unsub" } }),
      );
      await waitForMessage(ws); // subscribe.ack

      // Unsubscribe
      ws.send(
        JSON.stringify({ type: "unsubscribe", data: { transactionId: "tx-unsub" } }),
      );

      // Small delay to let the unsubscribe message reach the server
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const received: unknown[] = [];
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });

      await manager.broadcastTransactionUpdate({ id: "tx-unsub", status: "pending" });
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(received).toHaveLength(0);
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // connectionCount
  // ---------------------------------------------------------------------------

  describe("connectionCount", () => {
    it("tracks the number of connected clients", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const before = manager.connectionCount;

      const ws1 = new WebSocket(`${baseUrl}?token=${makeToken({ userId: "c1", email: "c1@t.com" })}`);
      const ws2 = new WebSocket(`${baseUrl}?token=${makeToken({ userId: "c2", email: "c2@t.com" })}`);

      await waitForMessage(ws1);
      await waitForMessage(ws2);

      expect(manager.connectionCount).toBeGreaterThanOrEqual(before + 1);
      expect(manager.connectionCount).toBeLessThanOrEqual(before + 2);

      await closeWs(ws1);
      await closeWs(ws2);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(manager.connectionCount).toBeLessThanOrEqual(before);
    });
  });
});
