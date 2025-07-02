# Monitoring

The CDK construct allows for the configuration of an [ADOT Otel collector](https://aws-otel.github.io/docs) sidecar to run next to each Restate container.
To enable it, set `monitoring.otelCollector.enabled = true` in the props.

By default, the following pipelines are configured in the collector:
1. `metrics/ecs`: ECS container metrics are collected from the task metadata endpoint using the `awsecscontainermetrics` receiver. These are filtered and transformed into:
- `restate_ecs_memory_utilized` (Megabytes)
- `restate_ecs_memory_reserved` (Megabytes)
- `restate_ecs_cpu_utilized` (Percent)
- `restate_ecs_cpu_reserved` (vCPU)
- `restate_ecs_network_io_usage_rx_bytes` (Bytes)
- `restate_ecs_network_io_usage_tx_bytes` (Bytes)
- `restate_ecs_storage_read_bytes` (Bytes)
- `restate_ecs_storage_write_bytes` (Bytes)
2. `metrics/restate`: Restate's prometheus endpoint is scraped every 60s
3. `traces`: [Restate's traces](https://docs.restate.dev/operate/monitoring/tracing/) are accepted over OTLP, but Restate will only be configured to send them if `monitoring.otelCollector.traceOptions` are configured (see below).

To make use of these pipelines, you can provide values for the `exporters` section of the collector config, and provide the stack with the `metricExporterIds` and `traceExporterIds` for those exporters.

## Example
```js
{
  ...,
  monitoring: {
    otelCollector: {
      enabled: true,
      // by setting this object, we can define a tracing sampler and sampling ratio
      traceOptions: {
        sampler: "parentbased_traceidratio",
        samplerArg: "0.01", // 1%
      },
      configuration: {
        exporters: {
          // any exporters can be define here, in this case we use new relic otlp
          otlp: {
            endpoint: "https://otlp.eu01.nr-data.net:4317",
            headers: {
              // use environment variables to pass secrets
              "api-key": "${env:NEW_RELIC_API_KEY}",
            },
          },
        },
        // configure metrics to use the otlp exporter
        metricExporterIds: ["otlp"],
        // configure traces to use the otlp exporter
        traceExporterIds: ["otlp"],
      },
      secrets: {
        NEW_RELIC_API_KEY: cdk.aws_ecs.Secret.fromSecretsManager(
          cdk.aws_secretsmanager.Secret.fromSecretNameV2(
            this,
            "new-relic-license-key",
            "restate-byoc/new-relic-license-key",
          ),
        ),
      },
    },
  }
}
```

## Custom configuration
If you'd prefer to define your own pipelines you can set `monitoring.otelCollector.configuration.customConfig`.
