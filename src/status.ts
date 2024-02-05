type StatusOptions = {
  rollingCountBuckets: number;
  rollingCountTimeout: number;
  rollingPercentilesEnabled?: boolean;
  stats?: Stats;
};

type Bucket = {
  failures: number;
  successes: number;
  fires: number;
  timeouts: number;
  percentiles: { [key: number]: number };
  latencyTimes: number[];
  isCircuitBreakerOpen: boolean;
};

type Stats = Bucket & { latencyMean?: number };

class Status {
  private buckets: Bucket[];
  private timeout: number;
  private percentiles: number[] = [0.0, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.995, 1];
  private rollingPercentilesEnabled: boolean;
  private _stats?: Stats;
  private rotationTimer?: NodeJS.Timeout;

  constructor(options: StatusOptions) {
    this.buckets = Array.from({ length: options.rollingCountBuckets }, () => this.createBucket());
    this.timeout = options.rollingCountTimeout;
    this.rollingPercentilesEnabled = options.rollingPercentilesEnabled !== false;
    this.rotateBuckets();
  }

  private async rotateBuckets(): Promise<void> {
    this.rotationTimer = setInterval(() => {
      this.buckets.pop();
      this.buckets.unshift(this.createBucket());
    }, this.timeout / this.buckets.length);
  }

  get stats(): Stats {
    const aggregatedStats: Stats = this.buckets.reduce((acc: Stats, bucket: Bucket) => {
      acc.failures += bucket.failures;
      acc.successes += bucket.successes;
      acc.fires += bucket.fires;
      acc.timeouts += bucket.timeouts;
    
      // Always accumulate latencyTimes, regardless of rollingPercentilesEnabled
      acc.latencyTimes = [...acc.latencyTimes, ...bucket.latencyTimes];
    
      return acc;
    }, this.createBucket() as Stats);
  
    // Sort the latencyTimes for percentile calculation
    aggregatedStats.latencyTimes.sort((a, b) => a - b);
  
    // Calculate latencyMean
    aggregatedStats.latencyMean = aggregatedStats.latencyTimes.length > 0
      ? aggregatedStats.latencyTimes.reduce((acc, cur) => acc + cur, 0) / aggregatedStats.latencyTimes.length
      : 0;
  
    // Calculate Percentiles only if rollingPercentilesEnabled is true
    if (this.rollingPercentilesEnabled) {
      this.percentiles.forEach(percentile => {
        aggregatedStats.percentiles[percentile] = this.calculatePercentile(percentile, aggregatedStats.latencyTimes);
      });
    } else {
      // Ensure percentiles are set to 0 when disabled
      this.percentiles.forEach(percentile => {
        aggregatedStats.percentiles[percentile] = 0;
      });
    }

    aggregatedStats.isCircuitBreakerOpen = this.buckets[0].isCircuitBreakerOpen;
  
    return aggregatedStats;
  }
  
  private calculatePercentile(percentile: number, latencyTimes: number[]): number {
    if (latencyTimes.length === 0) return 0;
    if (percentile <= 0) return latencyTimes[0];
    if (percentile >= 1) return latencyTimes[latencyTimes.length - 1];
    
    const index = Math.ceil(percentile * latencyTimes.length) - 1;
    return latencyTimes[index];
  }

  public async increment(property: keyof Bucket, latencyRunTime?: number): Promise<void> {
    const currentBucket = this.buckets[0];
    currentBucket[property]++;
    if (latencyRunTime !== undefined) {
      currentBucket.latencyTimes.push(latencyRunTime);
    }
  }

  public open(): void {
    this.buckets[0].isCircuitBreakerOpen = true;
  }

  public close(): void {
    this.buckets[0].isCircuitBreakerOpen = false;
  }

  public async shutdown(): Promise<void> {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }
  }

  private createBucket(): Bucket {
    return {
      failures: 0,
      successes: 0,
      fires: 0,
      timeouts: 0,
      percentiles: {},
      latencyTimes: [],
      isCircuitBreakerOpen: false,
    };
  }
}

export { Status, StatusOptions, Bucket, Stats };