# Warm-turn SQL acceptance

Measure a real isolated Gateway through its WebSocket chat transport, using
synthetic sessions and a loopback provider. Keep the provider response, transcript
size, configuration, transport, and observer identical across revisions. Never
use operator state or capture SQL bindings or message contents.

Count successful SQL statements and worker requests per completed warm turn,
including all threads. Report MAIN separately. Attribute every statement shape
and request to its issuing owner; keep background and cold-start work separate.
The frozen SQL census workload is also a control for first turn, restart,
compaction, spawned sessions, and shutdown.

Preregister the tested commits and acceptance thresholds in the PR before running.
Interleave baseline and candidate, at least five warm turns each. Report median,
p95, and min–max for each count. A win requires fewer statements or requests per
warm turn without increasing another count or losing transcript, retry, custody,
or completion behavior. A 20% regression in any control cell stops the change.

Profile the same flow per thread. Report elapsed-time comparisons only on an
exclusive, quiet host; loaded-host counts and CPU samples do not establish latency.
Do not attribute a saving to moving work between threads or phases.
