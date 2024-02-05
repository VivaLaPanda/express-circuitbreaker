# Express Cowboy

## It calms the thundering herd

[GitHub](https://github.com/VivaLaPanda/express-circuitbreaker)

[![Build Status](https://travis-ci.org/VivaLaPanda/express-circuitbreaker.svg?branch=master)](https://travis-ci.org/VivaLaPanda/express-circuitbreaker)

<!-- [![Coverage Status](https://coveralls.io/repos/github/VivaLaPanda/express-circuitbreaker/badge.svg?branch=master)](https://coveralls.io/github/VivaLaPanda/express-circuitbreaker?branch=master)
[![npm version](https://badge.fury.io/js/express-cowboy.svg)](https://badge.fury.io/js/express-cowboy) -->

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
