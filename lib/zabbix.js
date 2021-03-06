/*
 * Flush stats to Zabbix (http://www.zabbix.com/).
 *
 * To enable this backend, include 'statsd-zabbix-backend'
 * in the backends configuration array:
 *
 *   backends: ['statsd-zabbix-backend']
 *
 * This backend supports the following config options:
 *
 *   zabbixHost:           Zabbix sever hostname or IP. [default: localhost]
 *   zabbixPort:           Zabbix server port. [default: 10051].
 *   zabbixTimeout:        Zabbix sender timeout for sending data
 *   zabbixMaxBatchSize:   Zabbix batch sender limit for maximum batch size
 *   zabbixMaxPublishConcurrency:
 *                         maximum number of parallel batches that can be sent to Zabbix
 *   zabbixSendTimestamps: Send StatsD provided timestamp each time data is flushed to Zabbix.
 *                         By default, when false, Zabbix will use the time it received the data.
 *                         [default: false]
 *   zabbixTargetHostname: Static hostname associated with the stats to send to Zabbix.
 *                         If not provided, a hostname will be decoded from the StatsD keys.
 *                         [default: undefined]
 *   zabbixPublisher:      Pluggable metrics filtering and publishing scripts. If not configured,
 *                         all metrics reported to statsd will be sent to zabbix
 *                         without any change.
 *   zabbixPublishItems:   2-level deep object that configures items categories
 *                         that need to be sent to zabbix. First level contains entries
 *                         that keep sets of true/false flags for different items categories.
 *                         [default: all items enabled]
 *                         Configuration example:
 *                         {
 *                           timers: { enabled: true, send_count: false, send_avg: false },
 *                           counters: { enabled: false }
 *                         }
 *
 */

const BatchSender = require('./zabbix-batch-sender');
const ZabbixSender = require('node-zabbix-sender');
const hostname = require('os').hostname();

const name = 'statsd-zabbix-backend';
const stats = {};

let logger;

/**
 * Returns current unix timestamp in ms.
 * @returns {number} Timestamp.
 */
function tsNow() {
  return Math.round(new Date().getTime() / 1000);
}

/**
 * Write a log.
 * @param {string} level Logging level.
 * @param {string} msg Message to write.
 * @returns {undefined}
 */
function log(level, msg) {
  logger(`${name}: ${msg}`, level);
}

const debug = log.bind(undefined, 'DEBUG');
const error = log.bind(undefined, 'ERROR');
const info = log.bind(undefined, 'INFO');

/**
 * Decode {host, key} from a stat.
 * @param {string} stat Metric name to decode.
 * @returns {Object} Object with {host, key} properties.
 */
function targetDecode(stat) {
  let host;
  let key;
  let namespace;

  const parts = stat.split('.');

  if (
    (stat.startsWith('logstash.') || stat.startsWith('kamon.'))
    && parts.length === 3
  ) {
    [namespace, host, key] = parts;

    // Modify target based on namespace
    if (namespace === 'logstash') {
      host = host.replace(/_/g, '.');
      key = key.replace(/_/g, '.');
    } else if (namespace === 'kamon') {
      host = host.replace(/_/g, '.');
    }
  } else if (stat.startsWith('statsd.')) {
    host = hostname;
    key = stat;
  } else {
    // Split parts by default separator
    [host, key] = stat.split('_');
  }

  if (!host || !key) {
    throw new Error(`failed to decode stat: ${stat}`);
  }

  return {
    host,
    key,
  };
}

/**
 * Generate {host, key} using a previously determined hostname.
 * @param {string} host Static hostname to return.
 * @param {string} stat Metric name to use as the key.
 * @returns {Object} Object with {host, key} properties.
 */
function targetStatic(host, stat) {
  return {
    host,
    key: stat,
  };
}

/**
 * Applies configured filters to metrics array.
 * @param {array} items Array of {host, key, value} objects, each object represents an instance
 * @param {object} batchSender Zabbix Batch Sender instance.
 * of a metric.
 * @returns {array} Array of {host, key, value} objects.
 */
function publishAll(items, batchSender) {
  batchSender.publishBatch(items);
}

/**
 *
 * @param {object} settings Freeform object describing settings
 * @param {string} settingName Attribute name that needs to be read
 * @param {object} defaultValue Default value in case if attribute was not found
 * @returns {object} returns setting value or defaultValue if setting was not specified
 */
function readSetting(settings, settingName, defaultValue) {
  if (!settings) {
    return defaultValue;
  }
  const optValue = settings[settingName];
  if (optValue === undefined) {
    return defaultValue;
  }
  return optValue;
}

/**
 * Generate items for a counter.
 * @param {object} publishOpts Items publishing options
 * @param {number} flushInterval How long stats were collected, for calculating average.
 * @param {string} host Hostname in Zabbix.
 * @param {string} key Item key in Zabbix.
 * @param {number} value Total collected during interval.
 * @returns {array} Array of {host, key, value} objects.
 */
function itemsForCounter(publishOpts, flushInterval, host, key, value) {
  const items = [];
  if (readSetting(publishOpts, 'enabled', true)) {
    const avg = value / (flushInterval / 1000); // calculate "per second" rate

    if (readSetting(publishOpts, 'send_total', true)) {
      items.push({
        host,
        key: `${key}[total]`,
        value,
      });
    }

    if (readSetting(publishOpts, 'send_avg', true)) {
      items.push({
        host,
        key: `${key}[avg]`,
        value: avg,
      });
    }
  }

  return items;
}

/**
 * Generate items for a timer.
 * @param {object} publishOpts Items publishing options
 * @param {array} percentiles Array of numbers, percentiles to calculate mean and max for.
 * @param {string} host Hostname in Zabbix.
 * @param {string} key Item key in Zabbix.
 * @param {number} data All timing values collected during interval.
 * @returns {array} Array of {host, key, value} objects.
 */
function itemsForTimer(publishOpts, percentiles, host, key, data) {
  const items = [];

  if (readSetting(publishOpts, 'enabled', true)) {
    const values = data.sort((a, b) => (a - b));
    const count = values.length;
    const min = values[0];
    const max = values[count - 1];

    let mean = min;
    let maxAtThreshold = max;

    if (readSetting(publishOpts, 'send_lower', true)) {
      items.push({
        host,
        key: `${key}[lower]`,
        value: min || 0,
      });
    }
    if (readSetting(publishOpts, 'send_upper', true)) {
      items.push({
        host,
        key: `${key}[upper]`,
        value: max || 0,
      });
    }
    if (readSetting(publishOpts, 'send_count', true)) {
      items.push({
        host,
        key: `${key}[count]`,
        value: count,
      });
    }

    const sendMeanPercentile = readSetting(publishOpts, 'send_mean_percentile', true);
    const sendUpperPercentile = readSetting(publishOpts, 'send_upper_percentile', true);
    const sendPercentile = sendMeanPercentile || sendUpperPercentile;

    if (sendPercentile) {
      percentiles.forEach((percentile) => {
        const strPercentile = percentile.toString().replace('.', '_');

        if (count > 1) {
          const thresholdIndex = Math.round(((100 - percentile) / 100) * count);
          const numInThreshold = count - thresholdIndex;
          const percentValues = values.slice(0, numInThreshold);
          maxAtThreshold = percentValues[numInThreshold - 1];

          // Average the remaining timings
          let sum = 0;
          for (let i = 0; i < numInThreshold; i += 1) {
            sum += percentValues[i];
          }

          mean = sum / numInThreshold;
        }

        if (sendMeanPercentile) {
          items.push({
            host,
            key: `${key}[mean][${strPercentile}]`,
            value: mean || 0,
          });
        }

        if (sendUpperPercentile) {
          items.push({
            host,
            key: `${key}[upper][${strPercentile}]`,
            value: maxAtThreshold || 0,
          });
        }
      });
    }
  }
  return items;
}

/**
 * Generate items for a gauge.
 * @param {object} publishOpts Items publishing options
 * @param {string} host Hostname in Zabbix.
 * @param {string} key Item key in Zabbix.
 * @param {number} value Current value of the gauge.
 * @returns {array} Array of {host, key, value} objects.
 */
function itemsForGauge(publishOpts, host, key, value) {
  const items = [];
  if (readSetting(publishOpts, 'enabled', true)) {
    items.push({
      host,
      key,
      value,
    });
  }
  return items;
}

/**
 * Flush metrics data to Zabbix.
 * @param {function} targetBuilder Returns a {host,key} object based on the stat provided.
 * @param {function} constructSender Function that constructs an instance
 * of Zabbix Batch Sender for sending stats to Zabbix.
 * @param {function} publisher Function that is responsible for sending stats items
 * to zabbix sender. Function can apply custom filtering or transformation.
 * @param {number} publishItems Defines what items to publish.
 * @param {number} flushInterval How long stats were collected, for calculating average.
 * @param {number} timestamp Time of flush as unix timestamp.
 * @param {Object} metrics Metrics provided by StatsD.
 * @returns {undefined}
 */
// eslint-disable-next-line max-len
function flush(targetBuilder, constructSender, publisher, publishItems, flushInterval, timestamp, metrics) {
  debug(`starting flush for timestamp ${timestamp}`);

  const allItems = [];
  const flushStart = tsNow();
  const handle = (processor, stat, value) => {
    try {
      const { host, key } = targetBuilder(stat);
      processor(host, key, value).forEach((item) => {
        allItems.push(item);
        debug(`${item.host} -> ${item.key} -> ${item.value}`);
      });
    } catch (err) {
      stats.last_exception = tsNow();
      error(err);
    }
  };

  const counterProcessor = itemsForCounter.bind(undefined, publishItems.counters, flushInterval);
  Object.keys(metrics.counters).forEach((stat) => {
    handle(counterProcessor, stat, metrics.counters[stat]);
  });

  const timerProcessor = itemsForTimer.bind(undefined, publishItems.timers, metrics.pctThreshold);
  Object.keys(metrics.timers).forEach((stat) => {
    handle(timerProcessor, stat, metrics.timers[stat]);
  });

  const guageProcessor = itemsForGauge.bind(undefined, publishItems.guages);
  Object.keys(metrics.gauges).forEach((stat) => {
    handle(guageProcessor, stat, metrics.gauges[stat]);
  });

  stats.flush_length = allItems.length;
  debug(`flushing ${stats.flush_length} items to zabbix`);

  // construct batch sender
  const sender = constructSender((response) => {
    if (response.errors && response.errors.length > 0) {
      stats.last_exception = tsNow();
      error(response.errors[0]);
      // eslint-disable-next-line no-param-reassign
    } else {
      stats.last_flush = timestamp;
      stats.flush_time = flushStart - stats.last_flush;
      debug(`flush completed in ${stats.flush_time} seconds`);
    }
    if (response.statusMessage) {
      info(response.statusMessage);
    }
    stats.flush_length = Math.max(response.total || 0, allItems.length);
  });

  // Send the items to Zabbix
  publisher(allItems, sender);
}

/**
 * Dump plugin stats.
 * @param {function} writeCb Callback to write stats to.
 * @returns {undefined}
 */
function status(writeCb) {
  Object.keys(stats).forEach((stat) => {
    writeCb(null, 'zabbix', stat, stats[stat]);
  });
}

/**
 * Initalize the plugin.
 * @param {number} startupTime Timestamp StatsD started.
 * @param {Object} config Global configuration provided to StatsD.
 * @param {Object} events Event handler to register actions on.
 * @param {Object} l Global logger instance.
 * @returns {boolean} Status of initialization.
 */
function init(startupTime, config, events, l) {
  logger = (msg, level) => {
    if (level === 'DEBUG' && !config.debug) {
      return;
    }
    l.log(msg, level);
  };

  let targetBuilder;
  if (config.zabbixTargetHostname) {
    targetBuilder = targetStatic.bind(undefined, config.zabbixTargetHostname);
  } else {
    targetBuilder = targetDecode;
  }

  const sender = new ZabbixSender({
    host: config.zabbixHost || 'localhost',
    port: config.zabbixPort || '10051',
    timeout: config.zabbixTimeout || 5000,
    with_timestamps: config.zabbixSendTimestamps || false,
  });

  let publisher = publishAll;
  if (config.zabbixPublisher) {
    const publisherFactory = require(config.zabbixPublisher); // eslint-disable-line global-require, import/no-dynamic-require, max-len
    publisher = publisherFactory(config, l);
    if (config.debug) {
      debug(`Loaded zabbix publisher: ${config.zabbixPublisher}`);
    }
  }

  function constructSender(callback) {
    const senderOpts = {
      maxBatchSize: config.zabbixMaxBatchSize,
      maxPublishConcurrency: config.zabbixMaxPublishConcurrency,
    };
    return new BatchSender.ZabbixBatchSender(senderOpts, sender, callback);
  }

  stats.last_flush = 0;
  stats.last_exception = 0;
  stats.flush_time = 0;
  stats.flush_length = 0;

  events.on('flush', flush.bind(undefined, targetBuilder, constructSender, publisher, config.zabbixPublishItems || {}, config.flushInterval));
  events.on('status', status);

  return true;
}

module.exports = {
  init,
  flush,
  status,
  stats,
  itemsForCounter,
  itemsForGauge,
  itemsForTimer,
  targetDecode,
  targetStatic,
};