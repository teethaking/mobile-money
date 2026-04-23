import * as StellarSdk from "stellar-sdk";

jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(),
  getNetworkPassphrase: jest.fn(() => StellarSdk.Networks.TESTNET),
}));

import { getStellarServer } from "../../config/stellar";
import { ChannelAccountsPool } from "../pool";

const mockGetStellarServer = getStellarServer as jest.Mock;

function makeChannelAccounts(count: number) {
  return Array.from({ length: count }, () => {
    const kp = StellarSdk.Keypair.random();
    return {
      publicKey: kp.publicKey(),
      secretKey: kp.secret(),
    };
  });
}

describe("ChannelAccountsPool", () => {
  afterEach(async () => {
    jest.clearAllMocks();
  });

  it("limits concurrent usage to pool size while serving 50+ requests", async () => {
    const channels = makeChannelAccounts(5);
    const server = {
      loadAccount: jest.fn(async (publicKey: string) => new StellarSdk.Account(publicKey, "100")),
    };
    mockGetStellarServer.mockReturnValue(server);

    const pool = new ChannelAccountsPool({ queueTimeoutMs: 2000 });
    await pool.initialize(channels);

    let active = 0;
    let maxActive = 0;

    const jobs = Array.from({ length: 50 }, async (_, index) => {
      const lease = await pool.acquire();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, index % 2 === 0 ? 5 : 2));
      active -= 1;
      lease.release(true, lease.account.sequence + BigInt(1));
    });

    await Promise.all(jobs);

    expect(maxActive).toBeLessThanOrEqual(5);
    expect(pool.getStats().availableAccounts).toBe(5);
    expect(pool.getStats().lockedAccounts).toBe(0);
    await pool.shutdown();
  });

  it("resyncs and retries on sequence mismatch", async () => {
    const channel = makeChannelAccounts(1)[0];
    const loadAccount = jest
      .fn()
      .mockResolvedValueOnce(new StellarSdk.Account(channel.publicKey, "100"))
      .mockResolvedValueOnce(new StellarSdk.Account(channel.publicKey, "150"));
    mockGetStellarServer.mockReturnValue({ loadAccount });

    const pool = new ChannelAccountsPool();
    await pool.initialize([channel]);

    const sequences: string[] = [];
    const result = await pool.submitTransaction(async (_sourcePublicKey, sequence) => {
      sequences.push(sequence.toString());
      if (sequences.length === 1) {
        throw new Error("Transaction Failed: tx_bad_seq");
      }
      return { hash: "ok-hash" };
    });

    expect(result).toEqual({ hash: "ok-hash" });
    expect(sequences).toEqual(["101", "151"]);
    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(pool.getStats().sequenceErrorCount).toBe(1);
    await pool.shutdown();
  });

  it("detects common sequence mismatch error shapes", () => {
    mockGetStellarServer.mockReturnValue({ loadAccount: jest.fn() });
    const pool = new ChannelAccountsPool();

    expect((pool as any).isSequenceError({ message: "Transaction Failed: tx_bad_seq" })).toBe(true);
    expect((pool as any).isSequenceError(new Error("some sequence mismatch happened"))).toBe(true);
    expect((pool as any).isSequenceError(new Error("some other error"))).toBe(false);
  });
});
