# Acceptance contracts

The JSON fixtures describe workflow scope and the six reviewed Python defects without
depending on either implementation language. `tests/contracts/acceptance.test.ts`
executes the shared contract regressions; engine, runtime and adapter suites exercise
the same behaviors with durable state, native processes and recorded command fixtures.

The workflow inventory also lists required live evidence. Passing offline fixture
tests does not establish GrapheneOS emulator or physical Pixel acceptance. Retain
actual EN/PL device recordings separately when qualifying a policy or UI adapter.
