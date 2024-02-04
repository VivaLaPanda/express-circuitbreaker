import { Status, Bucket, Stats } from './status';

describe('Status', () => {
  let status: Status;
  const options = { rollingCountBuckets: 10, rollingCountTimeout: 10000, rollingPercentilesEnabled: true };

  beforeEach(() => {
    jest.useFakeTimers();
    status = new Status(options);
  });

  afterEach(() => {
    status.shutdown();
    jest.useRealTimers();
  });

  describe('stats', () => {
    it('should aggregate statistics correctly and calculate percentiles accurately', async () => {
      // Populate with a variety of latency times to create a distribution
      await status.increment('successes', 50);
      await status.increment('successes', 100);
      await status.increment('successes', 150);
      await status.increment('successes', 200);
      await status.increment('successes', 250);
  
      const stats = status.stats;
  
      // Basic aggregation checks
      expect(stats.successes).toBe(5);
      expect(stats.failures).toBe(0); // Assuming no failures were incremented
      expect(stats.timeouts).toBe(0); // Assuming no timeouts were incremented
      expect(stats.latencyTimes).toEqual(expect.arrayContaining([50, 100, 150, 200, 250]));
      expect(stats.latencyMean).toBeCloseTo(150, 5);
  
      // Percentile checks
      // Assuming your percentiles array includes these values
      // and your calculatePercentile function is implemented correctly
      expect(stats.percentiles[0.25]).toBeCloseTo(100, 5); // 25th percentile close to 100
      expect(stats.percentiles[0.5]).toBeCloseTo(150, 5);  // 50th percentile (median) close to 150
      expect(stats.percentiles[0.75]).toBeCloseTo(200, 5); // 75th percentile close to 200
      expect(stats.percentiles[0.95]).toBeCloseTo(250, 5); // 95th percentile close to 250
    });

    it('should handle empty buckets correctly', () => {
      const stats = status.stats;
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.latencyMean).toBe(0);
      Object.values(stats.percentiles).forEach(percentileValue => {
        expect(percentileValue).toBe(0);
      });
    });

    it('should accurately calculate edge case percentiles', async () => {
      await status.increment('successes', 300); // Single entry
      let stats = status.stats;
      expect(stats.percentiles[0]).toBe(300);
      expect(stats.percentiles[1]).toBe(300);
    
      await status.increment('successes', 600); // Two entries
      stats = status.stats;
      expect(stats.percentiles[0]).toBeCloseTo(300, 5);
      expect(stats.percentiles[1]).toBeCloseTo(600, 5);
    });

    it('should correctly disable percentile calculations', async () => {
      status = new Status({ ...options, rollingPercentilesEnabled: false });
      
      // Populate with a variety of latency times to create a distribution
      await status.increment('successes', 50);
      await status.increment('successes', 100);
      await status.increment('successes', 150);
      await status.increment('successes', 200);
      await status.increment('successes', 250);
    
      const stats = status.stats;
      expect(stats.latencyTimes).toEqual(expect.arrayContaining([50, 100, 150, 200, 250]));
      expect(stats.percentiles).toEqual(expect.objectContaining({
        0: 0,
        0.25: 0,
        0.5: 0,
        0.75: 0,
        0.9: 0,
        0.95: 0,
        0.99: 0,
        0.995: 0,
        1: 0,
      }));
    });

    it('should accurately calculate stats with partial data', async () => {
      // Populate only the first few buckets
      await status.increment('successes', 100);
      jest.advanceTimersByTime(options.rollingCountTimeout / options.rollingCountBuckets); // Rotate once
      await status.increment('successes', 200);
    
      // Ensure stats are calculated correctly with partial data
      const stats = status.stats;
      expect(stats.successes).toBe(2);
      expect(stats.latencyMean).toBeCloseTo(150, 5);
    });
  });

  describe('rotateBuckets', () => {
    it('should rotate buckets correctly', async () => {
      await status.increment('successes', 100); 

      const initialFirstBucket = status['buckets'][0];
      const initialBucketCount = status['buckets'].length;

      expect(initialFirstBucket.successes).toBe(1); 

      // Advance time to trigger bucket rotation
      jest.advanceTimersByTime(options.rollingCountTimeout / options.rollingCountBuckets + 1);

      const newFirstBucket = status['buckets'][0];
      const newBucketCount = status['buckets'].length;

      // Verify a new bucket is at the start and the array length is unchanged
      expect(newFirstBucket).not.toEqual(initialFirstBucket);
      expect(newBucketCount).toEqual(initialBucketCount);

      // Additional verification to ensure the new bucket is indeed fresh
      // This assumes we have a way to inspect the bucket, e.g., via a stats method or direct access for testing
      expect(newFirstBucket.successes).toBe(0); // New bucket should not have the increment from before
    });
  });

  describe('shutdown', () => {
    it('should stop the rotation of buckets', async () => {
      jest.useFakeTimers();
      await status.shutdown();

      const preShutdownBucket = status['buckets'][0];
      jest.advanceTimersByTime(options.rollingCountTimeout / options.rollingCountBuckets);
      const postShutdownBucket = status['buckets'][0];

      expect(preShutdownBucket).toBe(postShutdownBucket); // Buckets should not rotate after shutdown
      jest.useRealTimers();
    });
  });

  describe('increment', () => {
    it('should correctly increment various properties', async () => {
      await status.increment('successes');
      await status.increment('failures');
      await status.increment('timeouts', 50);
  
      const stats = status.stats;
      expect(stats.successes).toBe(1);
      expect(stats.failures).toBe(1);
      expect(stats.timeouts).toBe(1);
      expect(stats.latencyTimes).toContain(50);
    });

    it('should correctly handle concurrent increments', async () => {
      const incrementPromises = Array.from({ length: 100 }, () => status.increment('successes'));
      await Promise.all(incrementPromises);
      const stats = status.stats;
      expect(stats.successes).toBe(100);
    });
  });

  describe('circuitBreaker', () => {
    it('should open and close the circuit breaker', () => {
      status.open();
      expect(status['buckets'][0].isCircuitBreakerOpen).toBe(true);
  
      status.close();
      expect(status['buckets'][0].isCircuitBreakerOpen).toBe(false);
    });
  });
});