# Legacy reminder store fixture

`scheduled-reminder-legacy.sqlite` is synthetic data generated with `ScheduledTasks.execute` and `tick` from source commit `5f9b582` before the receiver-facing body changes. No database rows were manually constructed. The public sequence created an every-minute reminder at 2026-10-15T02:00Z, ticked at 02:01Z with no usable channel to persist its original output, then disabled it. All account/target values are fixture identities.

The fixture verifies compatibility of a real pre-change saved task, operation hash and pending cache. Tests copy it into a disposable directory; never open this committed file writable.
