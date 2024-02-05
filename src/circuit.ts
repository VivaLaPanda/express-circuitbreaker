import EventEmitter from "events";
import express, { Request, Response } from "express";
import pino from "pino";
import { Status } from "./status";

interface CircuitBreakerOptionsParam {
  // Indicates if the circuit breaker should only log errors without stopping the execution flow.
  logOnly?: boolean;

  // The time in milliseconds that an action should be allowed to execute before timing out.
  // We won't actually cancel the underlying request, since that's not generally safe in Express
  // but we'll record it as a failure
  // Setting this to `false` disables the timeout feature.
  timeout?: number | false;

  // The time in milliseconds to wait before setting the breaker to `halfOpen` state,
  // and trying the action again.
  resetTimeout?: number;

  // Sets the duration of the statistical rolling window, in milliseconds.
  rollingCountTimeout?: number;

  // Sets the number of buckets the rolling statistical window is divided into.
  rollingCountBuckets?: number;

  // The circuit name to use when reporting stats. Defaults to the name of the function
  // this circuit controls.
  name?: string;

  // Indicates whether execution latencies should be tracked and calculated as percentiles.
  rollingPercentilesEnabled?: boolean;

  // The error percentage at which to open the circuit and start short-circuiting requests to fallback.
  errorThresholdPercentage?: number;

  // Whether this circuit is enabled upon construction.
  enabled?: boolean;

  // Determines whether to allow failures without opening the circuit during a brief warmup period.
  // This can help in situations where, regardless of the `errorThresholdPercentage`, if the first
  // execution times out or fails, the circuit immediately opens.
  allowWarmUp?: boolean;

  // The minimum number of requests within the rolling statistical window that must exist
  // before the circuit breaker can open. This ensures that the circuit remains closed if
  // the number of requests within the statistical window does not exceed this threshold,
  // regardless of how many failures there are.
  // Note that volumeThreshold is a == comparison, not a >= comparison.
  volumeThreshold?: number;

  // An optional function that will be called when the circuit's function fails (returns a rejected Promise).
  // If this function returns truthy, the circuit's failure statistics will not be incremented.
  // This is useful for handling specific error types differently, such as not counting HTTP 404 errors as failures.
  isError?: (res: Response) => boolean;

  // A logger instance for the circuit breaker to use for logging. Allows integration with different
  // logging libraries/frameworks.
  logger?: pino.Logger;

  // If you have multiple breakers in your app, the number of timers across breakers can get costly.
  // This option allows you to provide an EventEmitter that rotates the buckets so you can have one
  // global timer in your app. Make sure that you are emitting a 'rotate' event from this EventEmitter.
  // rotateBucketController?: EventEmitter;
}

type CircuitBreakerOptions = Required<CircuitBreakerOptionsParam>;

class CircuitBreakerMiddleware {
  // State variables
  private readonly status: Status;
  private readonly options: CircuitBreakerOptions;
  private readonly warmupTimeout: NodeJS.Timeout | null = null;

  private state: "open" | "closed" | "half-open" | "shutdown" = "closed";
  private warmUp: boolean;
  private lastTimerAt: number = Date.now();
  private resetTimeout: NodeJS.Timeout | null = null;

  constructor(options: CircuitBreakerOptionsParam = {}) {
    const defaultErrorFn = (res: Response) => res.statusCode >= 400;

    this.options = {
      name: "circuit-breaker-" + Math.random(),
      logOnly: false,
      timeout: 10000,
      resetTimeout: 30000,
      rollingCountTimeout: 10000,
      rollingCountBuckets: 10,
      rollingPercentilesEnabled: true,
      // capacity: Number.MAX_SAFE_INTEGER,
      errorThresholdPercentage: 50,
      enabled: true,
      allowWarmUp: false,
      volumeThreshold: 0,
      isError: defaultErrorFn,
      logger: pino(),
      ...options,
    };
    this.status = new Status({
      rollingCountBuckets: this.options.rollingCountBuckets,
      rollingCountTimeout: this.options.rollingCountTimeout,
      rollingPercentilesEnabled: this.options.rollingPercentilesEnabled,
    });

    this.warmUp = this.options.allowWarmUp;

    if (this.warmUp) {
      this.warmupTimeout = setTimeout(() => {
        this.warmUp = false;
      }, this.options.rollingCountTimeout);
    }

    this.options.logger = this.options.logger.child({
      name: this.options.name,
      type: "circuit-breaker",
      status: this.status.stats,
    });
  }

  private startTimer() {
    this.lastTimerAt = Date.now();
    this.resetTimeout = setTimeout(() => {
      this.options.logger.debug("Circuit breaker reset timeout: moving to half-open");
      this.state = "half-open";
    }, this.options.resetTimeout);
  }

  private async fail(err: Error, args: any[], latency: number) {
    await this.status.increment("failures");
    this.options.logger.warn({ err, args, latency }, "Circuit breaker failure");
    if (this.warmUp) return;

    const stats = this.status.stats;
    if (stats.fires < this.options.volumeThreshold && !(this.state === "half-open")) return;
    const errorRate = (stats.failures / stats.fires) * 100;
    if (errorRate > this.options.errorThresholdPercentage || this.state === "half-open") {
      this.open();
    }
  }

  public async success() {
    this.status.increment("successes");
    if (this.state === "half-open") {
      this.close();
    }
  }

  public open() {
    if (this.state !== "open") {
      this.state = "open";
      this.options.logger.warn("Circuit breaker opened");
      this.status.open();
      this.startTimer();
    }
  }

  public close() {
    if (this.state !== "closed") {
      if (this.resetTimeout) {
        clearTimeout(this.resetTimeout);
      }
      this.state = "closed";
      this.options.logger.info("Circuit breaker closed");
      this.status.close();
    }
  }

  public shutdown() {
    this.state = "shutdown";
    if (this.resetTimeout) {
      clearTimeout(this.resetTimeout);
    }
    if (this.warmupTimeout) {
      clearTimeout(this.warmupTimeout);
    }
    this.status.shutdown();
  }

  public async middleware(req: Request, res: Response, next: (err?: Error) => void): Promise<void> {
    const logger = this.options.logger;
    if (this.options.enabled === false) {
      next();
      return;
    }

    this.status.increment("fires");

    if (this.state === "open") {
      logger.warn("Circuit is open request rejected");
      if (!this.options.logOnly) {
        res.status(503).send("Service Unavailable");
        return;
      }
    }

    const startedAt: number = Date.now();
    let timeoutId: NodeJS.Timeout | null = null;
    if (this.options.timeout !== false) {
      timeoutId = setTimeout(() => {
        const latency: number = Date.now() - startedAt;
        this.status.increment("timeouts", latency);
        this.fail(new Error("Request timed out"), [], latency);
        logger.warn({ latency }, "Request timed out");
      }, this.options.timeout);
    }

    res.on("finish", () => {
      if (timeoutId) clearTimeout(timeoutId);
      const latency: number = Date.now() - startedAt;

      // Treat any 400 or 500 status code as a failure, unless an error filter is provided
      // in which case it will be called to determine if the response should be treated as a failure
      if (this.options.isError(res)) {
        this.fail(new Error("Request failed"), [], latency);
      } else {
        this.success()
          .then(() => {
            logger.info({ latency }, "Request succeeded");
          })
          .catch((err: Error) => {
            logger.error({ err, latency }, "Error in handling success");
          });
      }
    });

    res.on("close", () => {
      if (timeoutId) clearTimeout(timeoutId);
      const latency: number = Date.now() - startedAt;
      this.fail(new Error("Request closed prematurely"), [], latency);
      logger.warn({ latency }, "Request closed prematurely");
    });

    next();
  }
}

export default CircuitBreakerMiddleware;
