import pino from "pino";
import CircuitBreakerMiddleware from "./circuit";
import express, { Request, Response } from "express";

describe("CircuitBreakerMiddleware Tests", () => {
  let circuitBreaker: CircuitBreakerMiddleware;
  const options = {
    logOnly: false,
    timeout: 10000,
    resetTimeout: 30000,
    rollingCountTimeout: 30000,
    rollingCountBuckets: 10,
    rollingPercentilesEnabled: true,
    errorThresholdPercentage: 50,
    enabled: true,
    allowWarmUp: false,
    volumeThreshold: 0,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    circuitBreaker = new CircuitBreakerMiddleware(options);
  });

  afterEach(() => {
    circuitBreaker.shutdown();
    jest.useRealTimers();
  });

  const mockRequest = (options = {}): Request =>
    ({
      ...options,
      get: jest.fn(),
      header: jest.fn(),
      accepts: jest.fn(),
      acceptsCharsets: jest.fn(),
    } as unknown as Request);

  const mockResponse = (preHandler?: () => void): Response => {
    const res: Partial<Response> = {};
    res.statusCode = 200;
    res.status = jest.fn((code: number): Response => {
      res.statusCode = code;
      return res as Response;
    });
    res.send = jest.fn().mockReturnValue(res) as unknown as Response["send"];
    res.on = jest.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === "finish") {
        if (preHandler) {
          preHandler();
        }
        setImmediate(handler);
      }
    }) as unknown as Response["on"];
    return res as Response;
  };

  // State Transitions
  describe("State Transitions", () => {
    it("should transition from closed to open when error threshold exceeded", async () => {
      const req = mockRequest();
      const res = mockResponse();

      const next = jest.fn(() => {
        res.status(500).send("Error");
        jest.advanceTimersByTime(1);
      });

      for (let i = 0; i < options.volumeThreshold + 1; i++) {
        await circuitBreaker.middleware(req, res, next);
      }
      jest.advanceTimersByTime(1);

      expect(circuitBreaker["state"]).toBe("open");
    });

    it("should transition from open to half-open after resetTimeout", async () => {
      circuitBreaker.open(); // Manually open the circuit
      jest.advanceTimersByTime(options.resetTimeout + 1); // Fast-forward time

      // The next request should be allowed as the circuit is now half-open
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      expect(circuitBreaker["state"]).toBe("half-open");
      expect(next).toHaveBeenCalled();
    });

    it("should transition from half-open to closed on successful request", async () => {
      circuitBreaker.open();
      expect(circuitBreaker["state"]).toBe("open");
      jest.advanceTimersByTime(options.resetTimeout + 1);
      expect(circuitBreaker["state"]).toBe("half-open");

      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn(() => res.status(200).send("OK"));

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(options.resetTimeout + 1);

      expect(circuitBreaker["state"]).toBe("closed");
    });

    it("should transition from half-open to open on failed request", async () => {
      circuitBreaker.open();
      expect(circuitBreaker["state"]).toBe("open");
      jest.advanceTimersByTime(options.resetTimeout + 1);
      expect(circuitBreaker["state"]).toBe("half-open");

      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn(() => {
        res.status(500).send("Error");
        jest.advanceTimersByTime(1);
      });

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(1);

      expect(circuitBreaker["state"]).toBe("open");
    });

    it("should transition to shutdown from any state", async () => {
      circuitBreaker.open();
      expect(jest.getTimerCount()).not.toBe(0);
      circuitBreaker.shutdown();

      expect(circuitBreaker["state"]).toBe("shutdown");

      jest.advanceTimersByTime(1);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  // Request Handling
  describe("Request Handling", () => {
    it("should allow request when circuit is closed", async () => {
      circuitBreaker.close();
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(1);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(503);
    });

    it("should block request when circuit is open and logOnly is false", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({ ...options, logOnly: false });
      circuitBreaker.open();
      const req: Request = mockRequest();
      const res: any = mockResponse();
      const next: jest.Mock = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.send).toHaveBeenCalledWith("Service Unavailable");
    });

    it("should log but not block request when logOnly is true and circuit is open", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({ ...options, logOnly: true });
      circuitBreaker.open();
      const req: Request = mockRequest();
      const res: any = mockResponse();
      const next: jest.Mock = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(503);
    });

    it("should allow request when circuit is half-open", async () => {
      circuitBreaker.open();
      jest.advanceTimersByTime(options.resetTimeout + 1);
      expect(circuitBreaker["state"]).toBe("half-open");

      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // Timeouts and Delays
  describe("Timeouts and Delays", () => {
    it("should handle request that completes just before timeout without tripping", async () => {
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn(() => {
        setTimeout(() => res.status(200).send("OK"), options.timeout - 1);
      });

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(options.timeout - 1);

      expect(circuitBreaker["state"]).toBe("closed");
      expect(next).toHaveBeenCalled();
    });

    it("should count request exceeding timeout as a timeout", async () => {
      const req = mockRequest();

      const preHandler = () => {
        jest.advanceTimersByTime(options.timeout + 10);
      };
      const res = mockResponse(preHandler);
      const next = jest.fn(() => {
        setTimeout(() => res.status(500).send("Error"), options.timeout + 1);
      });

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(1);

      expect(circuitBreaker["status"].stats.failures).toBe(1);
      expect(circuitBreaker["status"].stats.timeouts).toBe(1);
      expect(circuitBreaker["state"]).toBe("open");
    });

    it("should support multiple timeouts before opening", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        volumeThreshold: 2,
      });
      const req = mockRequest();

      const preHandler = () => {
        jest.advanceTimersByTime(options.timeout + 10);
      };
      const res = mockResponse(preHandler);
      const next = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(1);

      expect(circuitBreaker["status"].stats.failures).toBe(1);
      expect(circuitBreaker["status"].stats.timeouts).toBe(1);
      expect(circuitBreaker["state"]).toBe("closed");

      await circuitBreaker.middleware(req, res, next);
      jest.advanceTimersByTime(2);
      expect(circuitBreaker["status"].stats.failures).toBe(2);
      expect(circuitBreaker["status"].stats.timeouts).toBe(2);
      expect(circuitBreaker["state"]).toBe("open");
    });
  });

  describe("Fail", () => {
    it("should not open the circuit if failures do not exceed volume threshold", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({ ...options, volumeThreshold: 5 });
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn(() => res.status(500).send("Error"));

      for (let i = 0; i < 4; i++) {
        // Less than volumeThreshold
        await circuitBreaker.middleware(req, res, next);
        jest.advanceTimersByTime(1);
      }

      expect(circuitBreaker["state"]).toBe("closed");
    });

    it("should not open the circuit if error rate does not exceed threshold", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        volumeThreshold: 3,
        errorThresholdPercentage: 75,
      });
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn();

      // 3 failures, 2 successes - 60% failure rate, below the 75% threshold
      for (let i = 0; i < 3; i++) {
        next.mockImplementationOnce(() => res.status(500).send("Error"));
        await circuitBreaker.middleware(req, res, next);
        jest.advanceTimersByTime(1);
      }
      for (let i = 0; i < 2; i++) {
        next.mockImplementationOnce(() => res.status(200).send("OK"));
        await circuitBreaker.middleware(req, res, next);
        jest.advanceTimersByTime(1);
      }

      expect(circuitBreaker["state"]).toBe("closed");
    });

    it("should open the circuit if both volume threshold and error rate are exceeded", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        volumeThreshold: 3,
        errorThresholdPercentage: 50,
      });
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn(() => res.status(500).send("Error"));

      for (let i = 0; i < 4; i++) {
        // Exceeds volumeThreshold with 100% failure rate
        await circuitBreaker.middleware(req, res, next);
        jest.advanceTimersByTime(1);
      }

      expect(circuitBreaker["state"]).toBe("open");
    });

    it("should not open the circuit due to failures during warm-up period", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        allowWarmUp: true,
        volumeThreshold: 3,
      });
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn(() => res.status(500).send("Error"));

      for (let i = 0; i < 3; i++) {
        await circuitBreaker.middleware(req, res, next);
        jest.advanceTimersByTime(1);
      }

      expect(circuitBreaker["status"].stats.failures).toBe(3);
      expect(circuitBreaker["state"]).toBe("closed");
      jest.advanceTimersByTime(options.rollingCountTimeout + 1);
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.middleware(req, res, next);
        jest.advanceTimersByTime(1);
      }
      expect(circuitBreaker["status"].stats.failures).toBe(3);
      expect(circuitBreaker["state"]).toBe("open");
    });

    it("should keep the circuit closed if error rate is below threshold despite exceeding volume threshold", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        volumeThreshold: 3,
        errorThresholdPercentage: 50,
      });
      const req = mockRequest();
      const res = mockResponse();
      const nextFail = jest.fn(() => res.status(500).send("Error"));
      const nextSuccess = jest.fn(() => res.status(200).send("OK"));

      for (let i = 0; i < 3; i++) {
        await circuitBreaker.middleware(req, res, nextSuccess);
        jest.advanceTimersByTime(1);
      }
      for (let i = 0; i < 2; i++) {
        await circuitBreaker.middleware(req, res, nextFail);
        jest.advanceTimersByTime(1);
      }

      expect(circuitBreaker["status"].stats.failures).toBe(2);
      expect(circuitBreaker["status"].stats.successes).toBe(3);
      expect(circuitBreaker["state"]).toBe("closed");
    });
  });

  describe("Error Handling and Filtering", () => {
    it("should treat 400 and 500 status codes as failures by default", async () => {
      const req = mockRequest();
      const res = mockResponse(() => res.status(500).send("Server Error"));
      const next = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      jest.advanceTimersByTime(1);

      expect(circuitBreaker["status"].stats.failures).toBe(1);
    });

    it("should not treat 400 and 500 status codes as failures when custom errorFilter is provided", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        isError: (res: Response) => res.statusCode >= 500, // Only consider 500 and above as errors
      });
      const req = mockRequest();
      const res400 = mockResponse(() => res400.status(400).send("Bad Request"));
      const res500 = mockResponse(() => res500.status(500).send("Server Error"));
      const next = jest.fn();

      await circuitBreaker.middleware(req, res400, next);
      jest.advanceTimersByTime(1);
      expect(circuitBreaker["status"].stats.failures).toBe(0); // 400 should not be treated as failure

      await circuitBreaker.middleware(req, res500, next);
      jest.advanceTimersByTime(1);
      expect(circuitBreaker["status"].stats.failures).toBe(1); // 500 should be treated as failure
    });

    it("should increment failures for responses filtered as errors", async () => {
      circuitBreaker = new CircuitBreakerMiddleware({
        ...options,
        isError: (res: Response) => res.statusCode === 503, // Only consider 503 as errors
      });
      const req = mockRequest();
      const res503 = mockResponse(() => res503.status(503).send("Service Unavailable"));
      const next = jest.fn();

      await circuitBreaker.middleware(req, res503, next);
      jest.advanceTimersByTime(1);

      expect(circuitBreaker["status"].stats.failures).toBe(1);
    });

    it("should not increment failures for successful responses", async () => {
      const req = mockRequest();
      const res200 = mockResponse(() => res200.status(200).send("OK"));
      const next = jest.fn();

      await circuitBreaker.middleware(req, res200, next);
      jest.advanceTimersByTime(1);

      expect(circuitBreaker["status"].stats.failures).toBe(0);
    });
  });

  // Configuration and Customization
  describe("Configuration and Customization", () => {
    // Scaffolding for tests related to various configurations
  });

  // Logging
  describe("Logging", () => {
    // Scaffolding for logging tests
  });

  // Shutdown Behavior
  describe("Shutdown Behavior", () => {
    it("should correctly shutdown the circuit breaker", async () => {
      circuitBreaker.shutdown();
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn();

      await circuitBreaker.middleware(req, res, next);

      // Expectations here would depend on how shutdown behavior is defined,
      // for example, you might expect next to always be called, or for certain
      // resources to be cleaned up.
      expect(next).toHaveBeenCalled();
    });

    // Scaffolding for additional shutdown behavior tests
  });
});
