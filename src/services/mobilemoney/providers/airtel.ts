import axios, { AxiosInstance } from "axios";

export class AirtelService {
  private client: AxiosInstance;
  private token: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.AIRTEL_BASE_URL,
      timeout: 10000,
    });
  }

  /**
   * =========================
   * AUTHENTICATION
   * =========================
   */
  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    try {
      const response = await this.client.post("/auth/oauth2/token", null, {
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.AIRTEL_API_KEY}:${process.env.AIRTEL_API_SECRET}`
            ).toString("base64"),
        },
      });

      this.token = response.data.access_token;
      this.tokenExpiry = Date.now() + response.data.expires_in * 1000;

      return this.token!;
    } catch (error) {
      console.error("Airtel auth failed", error);
      throw new Error("Airtel authentication failed");
    }
  }

  /**
   * =========================
   * RETRY WRAPPER
   * =========================
   */
  private async withRetry(fn: () => Promise<any>, retries = 3) {
    let lastError;

    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;

        // Retry only for transient errors
        if (err.response?.status >= 500 || err.code === "ECONNABORTED") {
          console.warn(`Retrying Airtel request (${i + 1})`);
          await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
          continue;
        }

        throw err;
      }
    }

    throw lastError;
  }

  /**
   * =========================
   * REQUEST PAYMENT (COLLECTION)
   * =========================
   */
  async requestPayment({
    amount,
    phoneNumber,
    reference,
  }: {
    amount: number;
    phoneNumber: string;
    reference: string;
  }) {
    const token = await this.authenticate();

    return this.withRetry(async () => {
      const response = await this.client.post(
        "/merchant/v1/payments/",
        {
          reference,
          subscriber: {
            country: "NG",
            currency: "NGN",
            msisdn: phoneNumber,
          },
          transaction: {
            amount,
            country: "NG",
            currency: "NGN",
            id: reference,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Country": "NG",
            "X-Currency": "NGN",
          },
        }
      );

      return response.data;
    });
  }

  /**
   * =========================
   * CHECK TRANSACTION STATUS
   * =========================
   */
  async checkStatus(reference: string) {
    const token = await this.authenticate();

    return this.withRetry(async () => {
      const response = await this.client.get(
        `/standard/v1/payments/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Country": "NG",
            "X-Currency": "NGN",
          },
        }
      );

      return response.data;
    });
  }

  /**
   * =========================
   * PAYOUT (DISBURSEMENT)
   * =========================
   */
  async payout({
    amount,
    phoneNumber,
    reference,
  }: {
    amount: number;
    phoneNumber: string;
    reference: string;
  }) {
    const token = await this.authenticate();

    return this.withRetry(async () => {
      const response = await this.client.post(
        "/standard/v1/disbursements/",
        {
          reference,
          payee: {
            msisdn: phoneNumber,
          },
          transaction: {
            amount,
            id: reference,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Country": "NG",
            "X-Currency": "NGN",
          },
        }
      );

      return response.data;
    });
  }
}