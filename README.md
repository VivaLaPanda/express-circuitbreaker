# Express Cowboy

## It calms the thundering herd

[![Build Status](https://travis-ci.org/expressjs/circuitbreaker.svg?branch=master)](https://travis-ci.org/expressjs/circuitbreaker)

[NPM](https://www.npmjs.com/package/express-cowboy)

## Why?

When you have a service that is failing, you don't want to keep hitting it. You want to give it a break and try again later. This is what circuit breakers are for.

For some reason NPM didn't have anything good for Express. Now it does.

This code is heavily based on Opossum's Circuit Breaker implementation.

## How?

```typescript
import * as express from "express";
import { circuitBreakerMiddleware } from "express-cowboy";

const app = express();
const cb = circuitBreakerMiddleware({
  maxFailures: 5,
  timeout: 10000,
  resetTimeout: 30000,
});
app.use(cb.middleware);
```
