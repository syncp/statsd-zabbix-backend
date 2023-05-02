# StatsD Zabbix backend [![Build Status](https://travis-ci.org/parkerd/statsd-zabbix-backend.svg?branch=master)](https://travis-ci.org/parkerd/statsd-zabbix-backend)

Backend for [StatsD](https://github.com/etsy/statsd) to publish stats to Zabbix.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Installation](#installation)
- [Configuration](#configuration)
  - [Options](#options)
- [Usage](#usage)
  - [Zabbix](#zabbix)
  - [Stat Names](#stat-names)
  - [Static Hostname](#static-hostname)
  - [Logstash](#logstash)
    - [Counters](#counters)
    - [Timers](#timers)
    - [Gauges](#gauges)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Installation

Tested with Node 6+.

To install it, you need to use a clone of this repository.

## Configuration

Example StatsD configuration:

```js
{
  debug: true,
  flushInterval: 10000,
  percentThreshold: [95, 99],
  backends: ["statsd-zabbix-backend"],
  zabbixHost: "zabbix.example.com",
}
```

### Options

- `zabbixHost`: Hostname or IP for Zabbix server [default: localhost]
- `zabbixPort`: Port for Zabbix server [default: 10051]
- `zabbixTimeout`: Timeout for sending data to Zabbix
- `zabbixMaxBatchSize`: Zabbix batch sender limit for maximum batch size
- `zabbixMaxPublishConcurrency`: Maximum number of parallel batches that can be sent to Zabbix
- `zabbixSendTimestamps`: Send timestamps to Zabbix, otherwise  [default: false]
- `zabbixTargetHostname`: Set static hostname, use full stat as key [default: undefined]
- `zabbixPublisher`: Pluggable metrics filtering and publishing scripts. If not configured, all metrics reported to statsd will be sent to Zabbix without any change.
- `zabbixPublishItems`: 2-level deep object that configures items categories that need to be sent to zabbix. First level contains entries that keep sets of true/false flags for different items categories. [default: all items enabled]. Example: 
```js
zabbixPublishItems: {
  timers: {
    enabled: true,
    send_lower: false,
    send_upper: false,
    send_avg: false
    send_count: false,
    send_mean_percentile: false,
    },
  counters: {
      enabled: false
    },
  guages: {
      enabled: false
  },
}
```
There is special zabbix publisher designed specificaly to bring Zabbix LLD (Low Level Discovery) to statsd - `./zabbix-autodiscovery-publisher`. In case if this zabbixPublisher is chosen, then following items become available for configuration:
- `zabbixDiscoveryKey`: defines zabbix discovery key. This value is used as target metric name to send discovery packages to Zabbix. [default: statsd.discovery]
- `zabbixDiscoveryMode`: Defines what discovery mode needs to be used by this publisher. [none, simple, detailed, default: simple]
- `zabbixDiscoverySegmentsCount`: Number of segments in advanced discovery mode. [default: 5]
- `zabbixDiscoverySegmentsSeparator`: Separator for detailed key splitting. [default: '.']
- `zabbixItemKeyPrefix`: Prefix to original metric name. This might be necessary for autodiscovery to work properly
- `zabbixItemKeySuffix`: Postfix to original metric name. This might be necessary for autodiscovery to work properly
- `zabbixMaxDiscoveryBatchSize`: Defines maximum discovery package size. As metrics discovery is a heavy operation, value for this setting should be choosen carefully.
- `zabbixPublishItems.metricsStats:`: The parameter define whether this publisher should publish metric sending statistics to zabbix as a separate metric.
- `zabbixPublishItems.discoveryStats`: The parameter define whether this publisher should publish metric discovery statistics to zabbix as a separate metric.

```js
{
...

  zabbixPublisher: './zabbix-autodiscovery-publisher',

  // ========================================
  // Configure zabbix-autodiscovery-publisher
  zabbixMaxDiscoveryBatchSize: 4,
  zabbixDiscoveryKey: 'nodejs2.discovery', //needs to be set in zabbix LLD rule
  zabbixDiscoveryMode: 'simple',
  zabbixDiscoverySegmentsCount: 5,
  zabbixItemKeyPrefix: 'statsd.[',	//needs to prefix original metric name for zabbix items discovered by LLD rule
  zabbixItemKeySuffix: ']',	//needs to postfix original metric name for zabbix items discovered by LLD rule

  // ========================================
  // Configure zabbix backend + zabbix-autodiscovery-publisher publishing settings
  zabbixPublishItems: {
    discoveryStats: { enabled: true },
    metricsStats: { enabled: true },
  },
...
}
```

## Usage

This plugin is primarily designed for use with logstash > statsd > zabbix pipline,
but should work for getting data from any source into Zabbix.

### Zabbix

All Zabbix items are expected to be type `Zabbix trapper` to support receiving push data.

Most values should be `decimal`. Average (avg) or mean values should be `float`.

### Stat Names

Send your host and key separated by an underscore, for example:

```
host.example.com_my.key:1|c
```

Stats starting with any of the following prefixes will be handled differently:

- `logstash.`
- `kamon.`
- `statsd.`

### Static Hostname

If you run statsd on each host, set option `zabbixTargetHostname`
to send all stats to a single host. In this mode, the full stat name
will be used as the item key in Zabbix.

### Logstash

Logstash's statsd output sends data in the format `namespace.sender.metric`.

- namespace: default is "logstash"
- sender: default is "%{host}", replacing dots with underscores
- metric: name of the metric used in increment

See Logstash examples for specific keys Zabbix will receive based on metric type.

**Note:** `sender` and `metric` will have underscores replaced by periods
before being sent to Zabbix.

#### Counters

Logstash statsd output using increment:

```
{
  statsd {
    host => "127.0.0.1"
    increment => ["my_key"]
  }
}
```

Logstash sends to Statsd: `logstash.host_example_com.my_key:1|c`.

Statsd calculates 2 values every `flushInterval` and sends each as a separate key to Zabbix for host "host.example.com":

- `my.key[avg]`
- `my.key[total]`

#### Timers

Logstash statsd output using timing:

```
{
  statsd {
    host => "127.0.0.1"
    timing => {
      "my_key" => "1"
    }
  }
}
```

Logstash sends to Statsd: `logstash.host_example_com.my_key:1|ms`

Given the percentThreshold in the example Statsd config, each of the following values would be calculated every flushInterval and sent as a separate keys to Zabbix for host "host.example.com":

- `my.key[mean][95]`
- `my.key[upper][95]`
- `my.key[mean][99]`
- `my.key[upper][99]`
- `my.key[upper]`
- `my.key[lower]`
- `my.key[count]`

#### Gauges

Gauges are also supported.

```
{
  statsd {
    host => "127.0.0.1"
    gauge => {
      "my_key" => "1"
    }
  }
}
```

Logstash sends to Statsd: `logstash.host_example_com.my_key:1|g`

Zabbix will receive a single item:

- `my.key`

#### LLD

LLD stands for [Zabbix Low Level Discovery](https://www.zabbix.com/documentation/3.4/manual/discovery/low_level_discovery) which is a nice feature of Zabbix that allows it to discover metrics dynamically removing the need of defining them manually through the template. Te idea is simple, when statsd observers a metric for the first time, it sends a special discovery item specifying discovery item key. Zabbix template for that special key parses received discovery item and creates metrics based on discovery item content and template configuration. 
Discovery item may look like this:
```js
{ "data": [ { "{#ITEMNAME}: "test.metric.name" } ] }
```
Zabbix Sender command for item discovery looks like this:
```
zabbix_sender.exe -z zabbix.dev -s web-01 -k metrics.discovery -o "{ \"data\":[ { \"{#ITEMNAME}\": \"test.metric.name\"} ] }"
```
As result of sending this command with configuration described above and proper zabbix template, following metric will be create:
```
statsd[test.metric.name]
```

**Note!** If there are squire bracets in metric name, such metric name should be escaped when the metric is being reported as [Zabbix escapes squire bracets in metric names](https://www.zabbix.com/documentation/3.4/manual/config/items/item/key). Example of such metric name could be:
```
statsd["db.request_time[count]"]
```

Command to send such metric looks like this:
```
zabbix_sender.exe -z zabbix.dev -s web-01 -k statsd.[test.metric.name] -o 1.3
zabbix_sender.exe -z zabbix.dev -s web-01 -k "statsd.[\"db.request_time[count]\"]" -o 1.3
```
