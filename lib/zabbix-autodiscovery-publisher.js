/*
 * Transforms stats before sending to Zabbix (http://www.zabbix.com/)
 * to make possible metrics auto discovery.
 *
 * To enable this publisher, include 'simple-discovery-filter'
 * in the zabbix backend filters configuration array:
 *
 *   zabbixPublisher:      './zabbix-discovery-publisher'
 *   zabbixDiscoveryKey:   defines zabbix discovery key. This value is used as target metric name
 *                         to send discovery packages to.
 *                         [default: statsd.discovery]
 *   zabbixDiscoveryMode:  Defines what discovery mode needs to be used by this publisher
 *                         [none, simple, detailed, default: simple]
 *   zabbixDiscoverySegmentsCount:
 *                         Number of segments in advanced discovery mode
 *                         [default: 5]
 *   zabbixDiscoverySegmentsSeparator:
 *                         Separator for detailed key splitting
 *                         [default: '.']
 *   zabbixItemKeyPrefix:  prefix to original metric name. This might be necessary
 *                         for autodiscovery to work properly
 *   zabbixItemKeySuffix:  postfix to original metric name. This might be necessary
 *                         for autodiscovery to work properly
 *   zabbixMaxDiscoveryBatchSize:
 *                         defines maximum discovery package size. As metrics discovery is
 *                         a heavy operation, value for this setting should be choosen carefully.
 *   zabbixPublishItems.metricsStats:
 *   zabbixPublishItems.discoveryStats
 *                         the parameters define whether this publisher should publish
 *                         metric sending statistics to zabbix as a separate metric.
 *                         [default: false]
 *
 * This filter is a simple version of metrics filtering and transformation script. It can be used
 * as a basis to build custom metric transformation logic required for a particular scenario
 * without customizing original zabbix backend. One of the use cases where it can be helpful
 * is the generation of autodiscovery items for zabbix. The provided version does this generation
 * with hardcoded discovery keys, data format and for all metrics when they appear for the first
 * time.
 *
 */

const reportPublishStatsDefault = false;

/**
 *
 * @param {object} settings Freeform object describing settings
 * @param {string} name Attribute name that needs to be read
 * @param {object} defaultValue Default value in case if attribute was not found
 * @returns {object} returns setting value or defaultValue if setting was not specified
 */
function readSetting(settings, name, defaultValue) {
  if (!settings) {
    return defaultValue;
  }
  const optValue = settings[name];
  if (optValue === undefined) {
    return defaultValue;
  }
  return optValue;
}

/**
 * Function generates list of metrics for specified stats object skipping those
 * that do not have values or have zero
 * @param {object} publishOpts Items publishing options
 * @param {object} stats publishing statistics {processed, failed, total, secondsSpent}
 * @param {object} prevStats publishing statistics from previous call,
 * object format: {processed, failed, total, secondsSpent}
 * @param {string} host zabbix target host name
 * @param {string} prefix metric prefix
 * @param {string} metricName statistics name
 * @returns {array} array of special stats metrics { host, key, value }
 */
function itemsForStats(publishOpts, stats, prevStats, host, prefix, metricName) {
  const items = [];
  if ((stats.processed || prevStats.processed) && readSetting(publishOpts, 'send_processed', true)) {
    items.push({
      host,
      key: `${prefix}.zabbix_publisher.${metricName}_processed`,
      value: stats.processed || 0,
    });
  }
  if ((stats.failed || prevStats.failed) && readSetting(publishOpts, 'send_failed', true)) {
    items.push({
      host,
      key: `${prefix}.zabbix_publisher.${metricName}_failed`,
      value: stats.failed || 0,
    });
  }
  if ((stats.total || prevStats.total) && readSetting(publishOpts, 'send_total', true)) {
    items.push({
      host,
      key: `${prefix}.zabbix_publisher.${metricName}_total`,
      value: stats.total || 0,
    });
  }
  if ((stats.secondsSpent || prevStats.secondsSpent) && readSetting(publishOpts, 'send_timespent', true)) {
    items.push({
      host,
      key: `${prefix}.zabbix_publisher.${metricName}_timespent`,
      value: stats.secondsSpent || 0,
    });
  }
  return items;
}

/**
 * Adds publish stats at the beginning of the metrics array
 * @param {Array} items Metric in form of {host, key, value} object.
 * @param {object} state Publisher instance state, here the function can store state that lives
 * through function calls.
 * @returns {void}
 */
function prependPublishStats(items, state) {
  if (state.reportPublishStats && state.publishStats.length > 0) {
    // determine zabbix target host name
    const localState = state;
    let host = localState.zabbixTargetHostname;
    if (!host && items.length > 0) {
      ([{ host }] = items);
      localState.zabbixTargetHostname = host;
    }
    // if host was not determined, simply skip sending for now
    if (host) {
      while (state.publishStats.length > 0) {
        const publishStats = state.publishStats.shift();
        const publishStatsPrev = localState.publishStatsPrev || {};
        if (readSetting(state.publishItems.metricsStats, 'enabled', reportPublishStatsDefault)) {
          const publishStatsItems = itemsForStats(state.publishItems.metricsStats, publishStats.metrics, publishStatsPrev.metrics || {}, host, localState.prefixStats, 'metric');
          publishStatsItems.forEach((it) => {
            items.unshift(it);
          });
        }
        if (readSetting(state.publishItems.discoveryStats, 'enabled', reportPublishStatsDefault)) {
          const discoveryStatsItems = itemsForStats(state.publishItems.discoveryStats, publishStats.discovery, publishStatsPrev.discovery || {}, host, localState.prefixStats, 'discovery');
          discoveryStatsItems.forEach((it) => {
            items.unshift(it);
          });
        }
        localState.publishStatsPrev = publishStats;
      }
    }
  }
}

/**
 * Function adds zabbix publish statistics to existing statistics object
 * @param {object} stats aggregated publish statistics {processed, failed, total, secondsSpent}
 * @param {object} zabbixState zabbis status response object
 * @returns {void}
 */
function updatePublishStats(stats, zabbixState) {
  const mutableStats = stats;
  mutableStats.processed = (mutableStats.processed || 0) + (zabbixState.processed || 0);
  mutableStats.failed = (mutableStats.failed || 0) + (zabbixState.failed || 0);
  mutableStats.total = (mutableStats.total || 0) + (zabbixState.total || 0);
  mutableStats.secondsSpent = (mutableStats.secondsSpent || 0.0)
    + (zabbixState.secondsSpent || 0.0);
}


/**
 * Determines whether a metric needs to be send to zabbix. Being corrected,
 * this function allows to filter metrics sent to zabbix easily. This in turn
 * allows to decrease load on zabbix.
 * @param {object} item Metric item in form of {host, key, value} object.
 * @returns {boolean} true if the metric needs to be send to zabbix
 */
function shouldSendMetric(item) { // eslint-disable-line no-unused-vars
  return true;
}

/**
 * Breaks up metric key into set of key's components
 * @param {string} key metric key
 * @param {object} state publisher state
 * @returns {object} dictionary with key-value pairs of parsed key
 */
function splitMetricKey(key, state) {
  const splitter = state.discoverySegmentsSeparator;
  const parts = key.split(splitter);
  const skey = {};
  const keyPrefix = '#COMPONENT';
  const none = '';
  const max = state.discoverySegmentsCount;
  for (let i = 0; i < max - 1; i += 1) {
    skey[`{${keyPrefix}${i + 1}}`] = (parts.length > i) ? parts[i] : none;
  }
  skey[`{${keyPrefix}${max}}`] = (parts.length >= max) ? parts.slice(max - 1).join(splitter) : none;
  return skey;
}

/**
 * Helper function that is used to build a metric discovery entry from metric instance.
 * @param {object} item Metric in form of {host, key, value} object.
 * @param {object} state Filter instance state, here the function can store state that lives throug
 * function calls.
 * @returns {object} An object containing auto discovery data for Zabbix. The format depends
 * of the zabbix configuration.
 */
function buildLldEntry(item, state) {
  switch (state.discoveryMode) {
    case 'none': return null;
    case 'simple': return {
      '{#ITEMNAME}': item.key,
    };
    case 'detailed': return splitMetricKey(item.key, state);
    default: throw Error(`Not supported discovery mode ${state.discoveryMode}`);
  }
}

/**
 * Helper function ensures that zabbix key is properly quoted if it is needed
 * @param {string} zabbixKey zabbix key that needs to be checked for escaping
 * @returns {string} valid zabbix key, quoted or original
 */
function quoteZabbixKey(zabbixKey) {
  if (zabbixKey.length !== 0
      && (zabbixKey[0] === '['
      || zabbixKey.indexOf(']') >= 0
      || zabbixKey.indexOf(',') >= 0)) {
    return `"${zabbixKey}"`;
  }
  return zabbixKey;
}

/**
 * Helper function that is used to wrap or modify a metric item if needed.
 * @param {object} item Metric in form of {host, key, value} object.
 * @param {object} state Filter instance state, here the function can store state that lives throug
 * function calls.
 * @returns {object} An object containing modified metric for Zabbix. The format depends
 * of the zabbix configuration.
 */
function wrapMetric(item, state) {
  if (state.discoveryMode === 'none') {
    return {
      host: item.host,
      key: `${state.keyPrefix}${item.key}${state.keySuffix}`,
      value: item.value,
    };
  }

  if (state.discoveryMode === 'simple') {
    const quotedKey = quoteZabbixKey(item.key);
    return {
      host: item.host,
      key: `${state.keyPrefix}${quotedKey}${state.keySuffix}`,
      value: item.value,
    };
  }

  const orderedParts = [];
  const skey = splitMetricKey(item.key, state);
  Object.keys(skey).sort().forEach((k) => {
    const quotedKey = quoteZabbixKey(skey[k]);
    orderedParts.push(quotedKey);
  });

  return {
    host: item.host,
    key: `${state.keyPrefix}${orderedParts.join(',')}${state.keySuffix}`,
    value: item.value,
  };
}

/**
 * Main function that implements metrics filtering logic.
 * @param {object} state Filter instance state, here the function can store state that lives throug
 * function calls.
 * @param {array} items Array of {host, key, value} objects (metrics).
 * @param {object} batchSender Zabbix batch sender.
 * @returns {array} of {host, key, value} objects. Technically, function can return original items
 * array or generate a new one.
 */
function publishItems(state, items, batchSender) {
  // declare variables
  const localState = state;
  let discoveryItemsCount = 0;
  const discovery = {};
  const dataItems = [];
  const publishStats = {
    metrics: {},
    discovery: {},
  };

  // process and clean publish stats
  prependPublishStats(items, localState);	
  dateTimeNow = Date.now() / 1000 | 0
  items.forEach((item) => {
    if (shouldSendMetric(item)) {
      // check whether the metric is being sent for the first time
      // if so, generate autodiscovery entry for it
      if ( localState.discoveryMode === 'none' ) { return; } 
	    if ( dateTimeNow - localState.discovered[item.key] > localState.secondsToReSendDiscovery  
		    || localState.discovered[item.key] === undefined ) {
        localState.logger.log(`Discovery triggered for ${item.key}`);
		    timediff = ( dateTimeNow - localState.discovered[item.key]);
        const isBroken = localState.discovered[item.key] === -1;
        const discoveryItem = buildLldEntry(item, state);
        const hostDiscovery = discovery[item.host] || (discovery[item.host] = { items: [], keys: [] }); // eslint-disable-line max-len
        const discoveryArray = isBroken ? [] : hostDiscovery.items;
        const discoveryKeys = isBroken ? [] : hostDiscovery.keys;
        discoveryArray.push(discoveryItem);
        discoveryKeys.push(item.key);
        // in case collected list of autodicovery items reached batch limit, format and publish it
        if (discoveryArray.length >= state.maxDiscoveryBatchSize || isBroken) {
          const discoveryEntry = {
            host: item.host,
            key: localState.discoveryKey,
            value: JSON.stringify({ data: discoveryArray }),
          };
          batchSender.publishBatch([discoveryEntry], (response) => {
            updatePublishStats(publishStats.discovery, response, localState.debug);
            const success = (response.failed === 0);
            const discoveryStatus = success ? dateTimeNow : -1;
            discoveryKeys.forEach((key) => {
              localState.discovered[key] = discoveryStatus;
            });
            if (localState.debug) {
              localState.logger.log(`[DEBUG] ${module.name}: Publishing zabbix autodiscovery item: ${JSON.stringify(discoveryEntry)}`);
            }
            if (isBroken && !success) {
              localState.logger.log(`[ERROR] ${module.name}: Autodiscovery does not work for ${item.key}`);
            }
          });
          // cleanup per-host discovery if this block was executed not for broken item
          if (!isBroken) {
            delete discovery[item.host];
          }
        }
        if (!isBroken) {
          discoveryItemsCount += discoveryKeys.length;
        }
      }
    }
    const wrappedItem = wrapMetric(item, state);
    dataItems.push(wrappedItem);
  });

  // check if there are unsent autodiscovery items, publish them first
  if (discoveryItemsCount > 0) {
    Object.keys(discovery).forEach((discoveryHost) => {
      const discoveryArray = discovery[discoveryHost].items;
      const discoveryKeys = discovery[discoveryHost].keys;
      const discoveryEntry = {
        host: discoveryHost,
        key: localState.discoveryKey,
        value: JSON.stringify({ data: discoveryArray }),
      };
      batchSender.publishBatch([discoveryEntry], (response) => {
        updatePublishStats(publishStats.discovery, response, localState.debug);
        const success = (response.failed === 0);
        const discoveryStatus = success ? dateTimeNow : -1;
        discoveryKeys.forEach((key) => {
          localState.discovered[key] = discoveryStatus;
        });
        if (success) {
          discoveryItemsCount += discoveryKeys.length;
        }
        if (localState.debug) {
          localState.logger.log(`[DEBUG] ${module.name}: Publishing zabbix autodiscovery item: ${JSON.stringify(discoveryEntry)}`);
        }
        if (!success) {
          const ks = discoveryKeys.join(', ');
          localState.logger.log(`[ERROR] ${module.name}: Autodiscovery does not work for one of the following keys: ${ks}`);
        }
      });
    });
  }

  // publish real metrics
  if (dataItems.length > 0) {
    batchSender.publishBatch(dataItems, (response) => {
      updatePublishStats(publishStats.metrics, response, localState.debug);
    });
  }

  // report metrics publishing completed
  batchSender.complete((stats) => {
    if (localState.reportPublishStats) {
      localState.publishStats.push(publishStats);
    }
    if (localState.debug) {
      localState.logger.log(`[DEBUG] ${module.name}: Zabbix status for all item types: ${stats.statusMessage}`);
    }
  });
}

/**
 * Filter instance factory function.
 * @param {object} config Zabbix configuration object.
 * @param {object} logger Zabbix system logger.
 * @returns {function} Initialized instance of the filter.
 */
function filterFactory(config, logger) {
  const publishItemsOpts = config.zabbixPublishItems || {};
  const state = {
    debug: config.debug || false,
    zabbixTargetHostname: config.zabbixTargetHostname,
    prefixStats: config.prefixStats || 'statsd',
    discoveryKey: config.zabbixDiscoveryKey || 'statsd.discovery',
    discoveryMode: (config.zabbixDiscoveryMode || 'simple').toLowerCase(),
    discoverySegmentsCount: config.zabbixDiscoverySegmentsCount || 5,
    discoverySegmentsSeparator: config.zabbixDiscoverySegmentsSeparator || '.',
    maxDiscoveryBatchSize: config.zabbixMaxDiscoveryBatchSize || Number.MAX_VALUE,
    keyPrefix: config.zabbixItemKeyPrefix || '',
    keySuffix: config.zabbixItemKeySuffix || '',
    publishItems: publishItemsOpts,
    reportPublishStats: readSetting(publishItemsOpts.metricsStats, 'enabled', reportPublishStatsDefault)
                        || readSetting(publishItemsOpts.discoveryStats, 'enabled', reportPublishStatsDefault),
    logger,
    discovered: {},
    publishStats: [],
	secondsToReSendDiscovery: config.secondsToReSendDiscovery || 10080,
  };

  return publishItems.bind(undefined, state);
}

const extraExports = {
  splitMetricKey,
  quoteZabbixKey,
  wrapMetric,
  buildLldEntry,
  prependPublishStats,
};

module.exports = Object.assign(filterFactory, extraExports);